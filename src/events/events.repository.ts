import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  Collection,
  Db,
  MongoClient,
  MongoServerError,
  ObjectId,
} from 'mongodb';
import { MONGO_CLIENT, MONGO_DB } from '../database/database.module.js';
import { initialState, replay } from '../processing/patient-state.js';
import { EventDocument } from './event.document.js';

const DUPLICATE_KEY_ERROR = 11000;

@Injectable()
export class EventsRepository implements OnModuleInit {
  private readonly collection: Collection<EventDocument>;

  constructor(
    @Inject(MONGO_DB) db: Db,
    @Inject(MONGO_CLIENT) private readonly client: MongoClient,
  ) {
    this.collection = db.collection<EventDocument>('events');
  }

  async onModuleInit(): Promise<void> {
    await this.collection.createIndex({ eventKey: 1 }, { unique: true });
    await this.collection.createIndex(
      { patientId: 1 },
      {
        unique: true,
        partialFilterExpression: { status: 'processing' },
        name: 'one_processing_per_patient',
      },
    );
    await this.collection.createIndex({ patientId: 1, ts: 1, eventKey: 1 });
    // Only unfinished events are indexed, so the index stays small as history grows.
    await this.collection.createIndex(
      { ts: 1 },
      {
        partialFilterExpression: { status: { $in: ['pending', 'processing'] } },
      },
    );
  }

  /**
   * Leases up to `limit` events, at most one per patient: the oldest unfinished
   * event, and only if no other event of that patient holds a live lease.
   */
  async claimBatch(limit: number, leaseMs: number): Promise<EventDocument[]> {
    const now = new Date();
    const heads = await this.collection
    // Aggregate to find the oldest unfinished event per patient that is not currently leased.
      .aggregate<{ _id: ObjectId }>([
        { $match: { status: { $in: ['pending', 'processing'] } } },
        // Reclaim an expired processing event before selecting a different pending event.
        { $sort: { status: -1, ts: 1, eventKey: 1 } },
        {
          $group: {
            _id: '$patientId',
            // The first event in the group, representing the oldest unfinished event for the patient.
            head: { $first: '$_id' },
            // Determine if any event in the group is currently leased.
            // how leased param work on mongodb
            // We use $max with $and to determine if any event in the group is currently leased.
            // If any event has status 'processing' and leaseUntil is greater than now, leased will be true.
            leased: {
              $max: {
                $and: [
                  { $eq: ['$status', 'processing'] },
                  { $gt: ['$leaseUntil', now] },
                ],
              },
            },
          },
        },
        // Only include groups where the head event is not currently leased.
        { $match: { leased: false } },
        { $limit: limit },
        // Project only the head event IDs for the next stage of processing.
        { $project: { _id: '$head' } },
      ])
      .toArray();

    const claimed = await Promise.all(
      heads.map(async ({ _id }) => {
        try {
          return await this.collection.findOneAndUpdate(
            {
              _id,
              // Ensure the event is either pending or has an expired lease.
              $or: [
                { status: 'pending' },
                { status: 'processing', leaseUntil: { $lte: now } },
              ],
            },
            {
              // Set the event to 'processing' and establish a new lease and claim token.
              $set: {
                status: 'processing',
                leaseUntil: new Date(now.getTime() + leaseMs),
                claimToken: randomUUID(),
              },
            },
            // Return the updated document after attempting to claim it.
            { returnDocument: 'after' },
          );
        } catch (error) {
          // A competing claimer can select a different head after a late arrival.
          if (
            error instanceof MongoServerError &&
            error.code === DUPLICATE_KEY_ERROR &&
            error.keyPattern?.patientId === 1
          )
            return null;
          throw error;
        }
      }),
    );
    // Filter out any null results from the claim attempts, returning only successfully claimed events.
    return claimed.filter(
      (doc): doc is NonNullable<typeof doc> => doc !== null,
    );
  }

  /**
   * Atomically publishes the output and the patient snapshots, fenced by the lease.
   * Replay starts from the previous snapshot, so the cost depends on how many
   * events are after this one, not on the patient's full history.
   */
  async commitReplay(
    event: EventDocument,
    output: Record<string, unknown>,
  ): Promise<boolean> {
    if (!event.claimToken)
      throw new Error(`Missing claim token for event ${event.eventKey}`);

    return this.client.withSession((session) =>
      session.withTransaction(
        async () => {
          // This write conflicts with reclaim/completion of the same lease. The unique
          // processing index prevents a different event of this patient from being claimed.
          const result = await this.collection.updateOne(
            {
              eventKey: event.eventKey,
              patientId: event.patientId,
              status: 'processing',
              claimToken: event.claimToken,
              leaseUntil: { $gt: new Date() },
            },
            {
              $set: { status: 'processed', processedAt: new Date(), output },
              $unset: { leaseUntil: '', claimToken: '' },
            },
            { session },
          );
          if (result.modifiedCount !== 1) return false;

          // Only this event and the ones after it can change. Everything before it
          // is already summarised in the previous snapshot.
          const processed = {
            patientId: event.patientId,
            status: 'processed' as const,
          };
          const previous = await this.collection.findOne(
            {
              ...processed,
              $or: [
                { ts: { $lt: event.ts } },
                { ts: event.ts, eventKey: { $lt: event.eventKey } },
              ],
            },
            {
              session,
              sort: { ts: -1, eventKey: -1 },
              projection: { stateAfter: 1 },
            },
          );
          // A predecessor without a snapshot (legacy data) forces a full replay.
          const fullReplay = previous !== null && !previous.stateAfter;
          const tail = await this.collection
            .find(
              fullReplay
                ? processed
                : {
                    ...processed,
                    $or: [
                      { ts: { $gt: event.ts } },
                      { ts: event.ts, eventKey: { $gte: event.eventKey } },
                    ],
                  },
              { session },
            )
            .sort({ ts: 1, eventKey: 1 })
            .toArray();
          const snapshots = replay(previous?.stateAfter ?? initialState, tail);
          await this.collection.bulkWrite(
            snapshots.map(({ eventKey, stateAfter }) => ({
              updateOne: {
                filter: { eventKey },
                update: { $set: { stateAfter } },
              },
            })),
            { session },
          );
          return true;
        },
        { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
      ),
    );
  }

  /** Returns false when the event was already stored. */
  async insertIfAbsent(event: EventDocument): Promise<boolean> {
    try {
      await this.collection.insertOne(event);
      return true;
    } catch (error) {
      if (
        error instanceof MongoServerError &&
        error.code === DUPLICATE_KEY_ERROR
      ) {
        return false;
      }
      throw error;
    }
  }
}

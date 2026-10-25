import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Db } from 'mongodb';
import { AppModule } from '../src/app.module.js';
import { MONGO_DB } from '../src/database/database.module.js';
import { EventDocument } from '../src/events/event.document.js';
import { EventsRepository } from '../src/events/events.repository.js';

let sequence = 0;
function pending(patientId: string, minute: number): EventDocument {
  return {
    eventKey: `k${sequence++}`,
    patientId,
    type: 't',
    data: {},
    ts: new Date(Date.UTC(2026, 0, 1, 10, minute)),
    status: 'pending',
    receivedAt: new Date(),
  };
}

describe('EventsRepository claim (e2e, requires MongoDB)', () => {
  let app: INestApplication;
  let db: Db;
  let repository: EventsRepository;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = await moduleRef.createNestApplication().init();
    db = app.get(MONGO_DB);
    repository = app.get(EventsRepository);
  });

  beforeEach(() => db.collection('events').deleteMany({}));

  afterAll(() => app.close());

  it('claims only the oldest event of each patient', async () => {
    await repository.insertIfAbsent(pending('p1', 5));
    await repository.insertIfAbsent(pending('p1', 1));
    await repository.insertIfAbsent(pending('p2', 3));

    const claimed = await repository.claimBatch(10, 60_000);

    const byPatient = Object.fromEntries(
      claimed.map((e) => [e.patientId, e.ts.getUTCMinutes()]),
    );
    expect(byPatient).toEqual({ p1: 1, p2: 3 });
    expect(
      claimed.every((e) => e.status === 'processing' && e.claimToken),
    ).toBe(true);
  });

  it('does not hand out the next event of a patient while one is being processed', async () => {
    await repository.insertIfAbsent(pending('p1', 1));
    await repository.insertIfAbsent(pending('p1', 2));

    await repository.claimBatch(10, 60_000);

    await expect(repository.claimBatch(10, 60_000)).resolves.toEqual([]);
  });

  it('never gives the same event to two concurrent claimers', async () => {
    await repository.insertIfAbsent(pending('p1', 1));

    const results = await Promise.all([
      repository.claimBatch(10, 60_000),
      repository.claimBatch(10, 60_000),
    ]);

    expect(results.flat()).toHaveLength(1);
  });

  it('respects the batch limit', async () => {
    for (const patient of ['p1', 'p2', 'p3'])
      await repository.insertIfAbsent(pending(patient, 1));

    await expect(repository.claimBatch(2, 60_000)).resolves.toHaveLength(2);
  });

  it('reclaims an event whose lease expired (worker died mid-processing)', async () => {
    await repository.insertIfAbsent(pending('p1', 1));
    const [first] = await repository.claimBatch(10, -1);

    const [second] = await repository.claimBatch(10, 60_000);

    expect(second.eventKey).toBe(first.eventKey);
    expect(second.claimToken).not.toBe(first.claimToken);
  });

  it('only the current lease holder can mark the event as processed', async () => {
    await repository.insertIfAbsent(pending('p1', 1));
    const [stale] = await repository.claimBatch(10, -1);
    const [current] = await repository.claimBatch(10, 60_000);

    await expect(repository.commitReplay(stale, {})).resolves.toBe(false);
    await expect(repository.commitReplay(current, {})).resolves.toBe(true);
    await expect(repository.claimBatch(10, 60_000)).resolves.toEqual([]);
  });

  it('replays late events and rewrites later snapshots in chronological order', async () => {
    const newer = pending('p1', 5);
    await repository.insertIfAbsent(newer);
    const [first] = await repository.claimBatch(1, 60_000);
    await repository.commitReplay(first, { value: 'new' });

    const older = pending('p1', 1);
    await repository.insertIfAbsent(older);
    const [late] = await repository.claimBatch(1, 60_000);
    await expect(repository.commitReplay(late, { value: 'old' })).resolves.toBe(
      true,
    );
    await expect(repository.commitReplay(late, { value: 'old' })).resolves.toBe(
      false,
    );

    const docs = await db
      .collection<EventDocument>('events')
      .find({ patientId: 'p1' })
      .sort({ ts: 1, eventKey: 1 })
      .toArray();
    expect(docs.map((doc) => doc.stateAfter?.eventCount)).toEqual([1, 2]);
    expect(docs[1].stateAfter?.latestByType).toEqual({ t: { value: 'new' } });
    expect(docs[0].output).toEqual({ value: 'old' });
  });

  it('continues from the previous snapshot instead of replaying the whole history', async () => {
    const seeded = {
      ...pending('p1', 1),
      status: 'processed' as const,
      output: { value: 'seed' },
      stateAfter: {
        eventCount: 41,
        latestByType: { t: { value: 'seed' } },
        asOf: new Date(Date.UTC(2026, 0, 1, 10, 1)),
      },
    };
    await repository.insertIfAbsent(seeded);
    await repository.insertIfAbsent(pending('p1', 2));
    const [claimed] = await repository.claimBatch(1, 60_000);

    await repository.commitReplay(claimed, { value: 2 });

    const events = db.collection<EventDocument>('events');
    const current = await events.findOne({ eventKey: claimed.eventKey });
    expect(current?.stateAfter).toEqual({
      eventCount: 42,
      latestByType: { t: { value: 2 } },
      asOf: claimed.ts,
    });
    const previous = await events.findOne({ eventKey: seeded.eventKey });
    expect(previous?.stateAfter).toEqual(seeded.stateAfter);
  });

  it('falls back to a full replay when the previous event has no snapshot', async () => {
    const legacy = {
      ...pending('p1', 1),
      status: 'processed' as const,
      output: { value: 1 },
    };
    await repository.insertIfAbsent(legacy);
    await repository.insertIfAbsent(pending('p1', 2));
    const [claimed] = await repository.claimBatch(1, 60_000);

    await repository.commitReplay(claimed, { value: 2 });

    const docs = await db
      .collection<EventDocument>('events')
      .find({ patientId: 'p1' })
      .sort({ ts: 1, eventKey: 1 })
      .toArray();
    expect(docs.map((doc) => doc.stateAfter?.eventCount)).toEqual([1, 2]);
  });

  it('rejects an expired owner without changing any snapshots', async () => {
    await repository.insertIfAbsent(pending('p1', 5));
    const [first] = await repository.claimBatch(1, 60_000);
    await repository.commitReplay(first, { value: 5 });
    await repository.insertIfAbsent(pending('p1', 1));
    const [stale] = await repository.claimBatch(1, -1);
    const [owner] = await repository.claimBatch(1, 60_000);
    await repository.commitReplay(owner, { value: 1 });
    const before = await db
      .collection('events')
      .find({})
      .sort({ eventKey: 1 })
      .toArray();

    await expect(
      repository.commitReplay(stale, { value: 'stale' }),
    ).resolves.toBe(false);
    expect(
      await db.collection('events').find({}).sort({ eventKey: 1 }).toArray(),
    ).toEqual(before);
  });

  it('rolls back the whole commit if replay fails', async () => {
    const broken = pending('p1', 5);
    await repository.insertIfAbsent({ ...broken, status: 'processed' });
    await repository.insertIfAbsent(pending('p1', 1));
    const [claimed] = await repository.claimBatch(1, 60_000);

    await expect(repository.commitReplay(claimed, {})).rejects.toThrow(
      'Missing output',
    );
    const stored = await db
      .collection('events')
      .findOne({ eventKey: claimed.eventKey });
    expect(stored?.status).toBe('processing');
    expect(stored?.output).toBeUndefined();
    expect(stored?.claimToken).toBe(claimed.claimToken);
  });

  it('reclaims the expired event before a newly arrived older event', async () => {
    await repository.insertIfAbsent(pending('p1', 5));
    const [expired] = await repository.claimBatch(1, -1);
    await repository.insertIfAbsent(pending('p1', 1));

    const claims = (
      await Promise.all([
        repository.claimBatch(1, 60_000),
        repository.claimBatch(1, 60_000),
      ])
    ).flat();
    expect(claims).toHaveLength(1);
    expect(claims[0].eventKey).toBe(expired.eventKey);
  });

  it('breaks timestamp ties deterministically by eventKey', async () => {
    const a = { ...pending('p1', 1), eventKey: 'a' };
    const b = { ...pending('p1', 1), eventKey: 'b' };
    await repository.insertIfAbsent(b);
    const [first] = await repository.claimBatch(1, 60_000);
    await repository.commitReplay(first, { value: 'b' });
    await repository.insertIfAbsent(a);
    const [late] = await repository.claimBatch(1, 60_000);
    await repository.commitReplay(late, { value: 'a' });

    const latest = await db
      .collection<EventDocument>('events')
      .findOne({ eventKey: 'b' });
    expect(latest?.stateAfter?.eventCount).toBe(2);
    expect(latest?.stateAfter?.latestByType).toEqual({ t: { value: 'b' } });
  });

  it('rolls back snapshots already written when a later snapshot write fails', async () => {
    const newer = pending('p1', 5);
    await repository.insertIfAbsent(newer);
    const [first] = await repository.claimBatch(1, 60_000);
    await repository.commitReplay(first, { value: 5 });
    await repository.insertIfAbsent(pending('p1', 1));
    const [late] = await repository.claimBatch(1, 60_000);
    const before = await db
      .collection('events')
      .find({})
      .sort({ eventKey: 1 })
      .toArray();

    await db.command({
      collMod: 'events',
      validator: {
        $nor: [{ eventKey: newer.eventKey, 'stateAfter.eventCount': 2 }],
      },
    });
    try {
      await expect(
        repository.commitReplay(late, { value: 1 }),
      ).rejects.toThrow();
      expect(
        await db.collection('events').find({}).sort({ eventKey: 1 }).toArray(),
      ).toEqual(before);
    } finally {
      await db.command({ collMod: 'events', validator: {} });
    }
  });

  it('enforces one processing document per patient in the database', async () => {
    await repository.insertIfAbsent(pending('p1', 5));
    await repository.claimBatch(1, 60_000);
    const older = pending('p1', 1);
    await repository.insertIfAbsent(older);
    await expect(
      db
        .collection('events')
        .updateOne(
          { eventKey: older.eventKey },
          { $set: { status: 'processing' } },
        ),
    ).rejects.toMatchObject({ code: 11000 });
  });
});

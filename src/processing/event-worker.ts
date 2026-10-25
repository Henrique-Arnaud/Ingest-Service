import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  BeforeApplicationShutdown,
} from '@nestjs/common';
import { env } from '../config/env.js';
import { EventDocument } from '../events/event.document.js';
import { EventsRepository } from '../events/events.repository.js';
import { EventHandler } from './event-handler.js';

export interface WorkerOptions {
  concurrency: number;
  leaseMs: number;
  pollMs: number;
}

export const WORKER_OPTIONS = Symbol('WORKER_OPTIONS');
export const defaultWorkerOptions: WorkerOptions = env.worker;

@Injectable()
export class EventWorker
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(EventWorker.name);
  private readonly inFlight = new Set<Promise<void>>();
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private claiming?: Promise<void>;

  constructor(
    private readonly repository: EventsRepository,
    private readonly handler: EventHandler,
    @Inject(WORKER_OPTIONS) private readonly options: WorkerOptions,
  ) {}

  onApplicationBootstrap(): void {
    if (env.worker.enabled) void this.loop();
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.claiming;
    await this.drain();
  }

  /** Claims as many events as there are free slots and starts processing them. */
  async tick(): Promise<void> {
    const freeSlots = this.options.concurrency - this.inFlight.size;
    if (freeSlots <= 0) return;
    try {
      // Claim a batch of events up to the number of free slots, each with a lease duration specified by leaseMs.
      const events = await this.repository.claimBatch(
        freeSlots,
        this.options.leaseMs,
      );
      events.forEach((event) => this.track(this.process(event)));
    } catch (error) {
      this.logger.error('Failed to claim events', error);
    }
  }

  async drain(): Promise<void> {
    //Instead of Promise.all, which would reject on the first failure, we use Promise.allSettled to wait for all in-flight work to complete regardless of individual failures.
    await Promise.allSettled(this.inFlight);
  }

  private async loop(): Promise<void> {
    this.claiming = this.tick();
    await this.claiming;
    if (!this.stopped)
      this.timer = setTimeout(() => void this.loop(), this.options.pollMs);
  }

  private track(work: Promise<void>): void {
    // Track the in-flight work by adding it to the set and ensuring it is removed once completed.
    this.inFlight.add(work);
    // Once the work is finished, remove it from the in-flight set.
    void work.finally(() => this.inFlight.delete(work));
  }

  // On failure the event stays leased and is retried once the lease expires.
  private async process(event: EventDocument): Promise<void> {
    try {
      const output = await this.handler.handle(event);
      const committed = await this.repository.commitReplay(event, output);
      if (!committed) {
        this.logger.warn(
          `Lease lost for event ${event.eventKey}; replay was not committed`,
        );
      }
    } catch (error) {
      this.logger.error(`Failed to process event ${event.eventKey}`, error);
    }
  }
}

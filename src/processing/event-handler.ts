import { Injectable } from '@nestjs/common';
import { env } from '../config/env.js';
import { EventDocument } from '../events/event.document.js';
export type EventOutput = Record<string, unknown>;

@Injectable()
export class EventHandler {
  async handle(event: EventDocument): Promise<EventOutput> {
    await new Promise((resolve) =>
      setTimeout(resolve, env.worker.processingMs),
    );
    return { ...event.data };
  }
}

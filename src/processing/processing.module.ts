import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module.js';
import { EventHandler } from './event-handler.js';
import { defaultWorkerOptions, EventWorker, WORKER_OPTIONS } from './event-worker.js';

@Module({
  imports: [EventsModule],
  providers: [
    EventHandler,
    EventWorker,
    { provide: WORKER_OPTIONS, useValue: defaultWorkerOptions },
  ],
})
export class ProcessingModule {}

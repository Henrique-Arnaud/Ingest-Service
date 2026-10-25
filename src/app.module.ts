import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller.js';
import { DatabaseModule } from './database/database.module.js';
import { EventsController } from './events/events.controller.js';
import { EventsService } from './events/events.service.js';
import { EventsModule } from './events/events.module.js';
import { ProcessingModule } from './processing/processing.module.js';

@Module({
  imports: [DatabaseModule, EventsModule, ProcessingModule],
  controllers: [HealthController, EventsController],
  providers: [EventsService],
})
export class AppModule {}

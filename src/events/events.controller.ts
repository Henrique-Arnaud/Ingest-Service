import { Controller, Post, HttpCode, Body } from '@nestjs/common';
import { EventsService } from './events.service.js';
import { CreateEventDto } from './dto/create-event.dto.js';

@Controller('events')
export class EventsController {
  constructor(private readonly service: EventsService) {}
  @Post()
  @HttpCode(202)
  ingest(@Body() dto: CreateEventDto): Promise<any> {
    return Promise.resolve({ message: 'Event ingested' });
  }
}

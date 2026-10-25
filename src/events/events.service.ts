import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { CreateEventDto } from './dto/create-event.dto.js';
import { EventsRepository } from './events.repository.js';

export interface IngestResult {
  duplicate: boolean;
}

@Injectable()
export class EventsService {
  constructor(private readonly repository: EventsRepository) {}

  /** Persists the event as pending; processing happens later, outside the request. */
  async ingest(dto: CreateEventDto): Promise<IngestResult> {
    const inserted = await this.repository.insertIfAbsent({
      eventKey: this.buildKey(dto),
      patientId: dto.patientId,
      type: dto.type,
      data: dto.data,
      ts: new Date(dto.ts),
      status: 'pending',
      receivedAt: new Date(),
    });
    return { duplicate: !inserted };
  }

  private buildKey(dto: CreateEventDto): string {
    const identity = [dto.patientId, dto.type, new Date(dto.ts).toISOString()];
    return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  }
}

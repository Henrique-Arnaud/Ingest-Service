import { Controller, Get, Inject } from '@nestjs/common';
import { Db, MongoAPIError } from 'mongodb';
import { MONGO_DB } from '../database/database.module.js';

@Controller('health')
export class HealthController {
  constructor(@Inject(MONGO_DB) private readonly db: Db) { }

  @Get()
  async checkHealth() {
    try {
      await this.db.command({ ping: 1 });
      return { status: 'ok' };
    } catch (error: unknown) {
      if (error instanceof MongoAPIError) {
        return { status: 'error', message: error.message };
      }
      return { status: 'error', message: 'Service is currently unavailable' };
    }
  }
}

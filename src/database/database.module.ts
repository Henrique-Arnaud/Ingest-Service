import { Injectable, Inject, OnApplicationShutdown, Global, Module } from '@nestjs/common';
import { MongoClient, Db } from 'mongodb';
import { env } from '../config/env.js';

export const MONGO_CLIENT = Symbol('MONGO_CLIENT');
export const MONGO_DB = Symbol('MONGO_DB');

@Injectable()
class MongoShutdown implements OnApplicationShutdown {
  constructor(@Inject(MONGO_CLIENT) private readonly client: MongoClient) {}

  async onApplicationShutdown(): Promise<void> {
    await this.client.close();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: MONGO_CLIENT,
      useFactory: () =>
        new MongoClient(env.mongoUri).connect(),
    },
    {
      provide: MONGO_DB,
      inject: [MONGO_CLIENT],
      useFactory: (client: MongoClient): Db => client.db(env.mongoDb),
    },
    MongoShutdown,
  ],
  exports: [MONGO_CLIENT, MONGO_DB],
})
export class DatabaseModule {}

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Db } from 'mongodb';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { MONGO_DB } from '../src/database/database.module.js';

const event = {
  patientId: 'p1',
  type: 'heart-rate',
  data: { bpm: 80 },
  ts: '2026-01-01T10:00:00.000Z',
};

describe('POST /events (e2e, requires MongoDB)', () => {
  let app: INestApplication;
  let db: Db;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    await app.init();
    db = app.get(MONGO_DB);
  });

  beforeEach(() => db.collection('events').deleteMany({}));

  afterAll(() => app.close());

  it('GET /health pings MongoDB', () =>
    request(app.getHttpServer()).get('/health').expect(200, { status: 'ok' }));

  it('accepts an event immediately and stores it as pending', async () => {
    await request(app.getHttpServer()).post('/events').send(event).expect(202, { duplicate: false });

    await expect(db.collection('events').countDocuments({ status: 'pending' })).resolves.toBe(1);
  });

  it('stores a retried event only once', async () => {
    await request(app.getHttpServer()).post('/events').send(event).expect(202);
    await request(app.getHttpServer()).post('/events').send(event).expect(202, { duplicate: true });

    await expect(db.collection('events').countDocuments()).resolves.toBe(1);
  });

  it('rejects an invalid payload', () =>
    request(app.getHttpServer()).post('/events').send({ patientId: 'p1' }).expect(400));
});

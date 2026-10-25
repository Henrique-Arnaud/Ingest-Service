import { EventsRepository } from './events.repository.js';
import { EventsService } from './events.service.js';

const dto = {
  patientId: 'p1',
  type: 'heart-rate',
  data: { bpm: 80 },
  ts: '2026-01-01T10:00:00.000Z',
};

describe('EventsService', () => {
  const insertIfAbsent = vi.fn();
  const service = new EventsService({ insertIfAbsent } as unknown as EventsRepository);

  beforeEach(() => insertIfAbsent.mockReset());

  it('stores a new event as pending', async () => {
    insertIfAbsent.mockResolvedValue(true);

    await expect(service.ingest(dto)).resolves.toEqual({ duplicate: false });
    expect(insertIfAbsent).toHaveBeenCalledWith(
      expect.objectContaining({ patientId: 'p1', status: 'pending', ts: new Date(dto.ts) }),
    );
  });

  it('reports a duplicate when the event was already stored', async () => {
    insertIfAbsent.mockResolvedValue(false);

    await expect(service.ingest(dto)).resolves.toEqual({ duplicate: true });
  });

  it('derives the same key for a retried event', async () => {
    insertIfAbsent.mockResolvedValue(true);

    await service.ingest(dto);
    await service.ingest({ ...dto });

    const [first, second] = insertIfAbsent.mock.calls.map(([doc]) => doc.eventKey);
    expect(first).toBe(second);
  });
});

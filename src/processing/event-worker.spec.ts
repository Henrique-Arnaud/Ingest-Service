import { EventDocument } from '../events/event.document.js';
import { EventsRepository } from '../events/events.repository.js';
import { EventHandler } from './event-handler.js';
import { EventWorker } from './event-worker.js';
import { Logger } from '@nestjs/common';

const options = { concurrency: 2, leaseMs: 60_000, pollMs: 1_000 };

function makeEvent(id: string): EventDocument {
  return {
    eventKey: id,
    patientId: id,
    type: 't',
    data: {},
    ts: new Date(),
    status: 'processing',
    receivedAt: new Date(),
    claimToken: `token-${id}`,
  };
}

describe('EventWorker', () => {
  const claimBatch = vi.fn();
  const commitReplay = vi.fn();
  const handle = vi.fn();
  const repository = {
    claimBatch,
    commitReplay,
  } as unknown as EventsRepository;
  const handler = { handle } as unknown as EventHandler;

  beforeEach(() => {
    claimBatch.mockReset().mockResolvedValue([]);
    commitReplay.mockReset().mockResolvedValue(true);
    handle.mockReset().mockResolvedValue({ value: 1 });
  });

  it('processes a claimed event and marks it as processed', async () => {
    const event = makeEvent('a');
    claimBatch.mockResolvedValueOnce([event]);
    const worker = new EventWorker(repository, handler, options);

    await worker.tick();
    await worker.drain();

    expect(handle).toHaveBeenCalledWith(event);
    expect(commitReplay).toHaveBeenCalledWith(event, { value: 1 });
  });

  it('never claims more than the free concurrency slots', async () => {
    const pending: Array<() => void> = [];
    handle.mockImplementation(
      () => new Promise<void>((resolve) => pending.push(resolve)),
    );
    claimBatch.mockResolvedValueOnce([makeEvent('a'), makeEvent('b')]);
    const worker = new EventWorker(repository, handler, options);

    await worker.tick();
    await worker.tick();

    expect(claimBatch).toHaveBeenNthCalledWith(1, 2, options.leaseMs);
    expect(claimBatch).toHaveBeenCalledTimes(1); // no free slot on the second tick

    pending.forEach((finish) => finish());
    await worker.drain();
    await worker.tick();
    expect(claimBatch).toHaveBeenLastCalledWith(2, options.leaseMs);
  });

  it('leaves the event leased when processing fails, so it is retried after the lease expires', async () => {
    claimBatch.mockResolvedValueOnce([makeEvent('a')]);
    handle.mockRejectedValue(new Error('external system down'));
    const worker = new EventWorker(repository, handler, options);

    await worker.tick();
    await worker.drain();

    expect(commitReplay).not.toHaveBeenCalled();
  });

  it('keeps running after a claim failure', async () => {
    claimBatch.mockRejectedValueOnce(new Error('mongo down'));
    const worker = new EventWorker(repository, handler, options);

    await expect(worker.tick()).resolves.toBeUndefined();
  });

  it('warns when the transaction rejects a lost lease', async () => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => {});
    try {
      claimBatch.mockResolvedValueOnce([makeEvent('a')]);
      commitReplay.mockResolvedValueOnce(false);
      const worker = new EventWorker(repository, handler, options);
      await worker.tick();
      await worker.drain();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Lease lost'));
    } finally {
      warn.mockRestore();
    }
  });

  it('drain waits for in-flight events', async () => {
    let finish!: () => void;
    handle.mockImplementation(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    claimBatch.mockResolvedValueOnce([makeEvent('a')]);
    const worker = new EventWorker(repository, handler, options);
    await worker.tick();

    const drained = worker.drain();
    expect(commitReplay).not.toHaveBeenCalled();
    finish();
    await drained;

    expect(commitReplay).toHaveBeenCalledTimes(1);
  });

  it('shutdown waits for a claim already in progress and then for its commit', async () => {
    const event = makeEvent('a');
    let finishClaim!: (events: EventDocument[]) => void;
    claimBatch.mockImplementationOnce(
      () => new Promise<EventDocument[]>((resolve) => (finishClaim = resolve)),
    );
    const worker = new EventWorker(repository, handler, options);
    worker.onApplicationBootstrap();
    const shutdown = worker.beforeApplicationShutdown();
    expect(commitReplay).not.toHaveBeenCalled();

    finishClaim([event]);
    await shutdown;

    expect(commitReplay).toHaveBeenCalledWith(event, { value: 1 });
    expect(claimBatch).toHaveBeenCalledTimes(1);
  });
});

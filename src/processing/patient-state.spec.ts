import type { EventDocument } from '../events/event.document.js';
import { initialState, replay } from './patient-state.js';

describe('patient state replay', () => {
  it('builds snapshots without mutating the starting state', () => {
    const events: EventDocument[] = [1, 2].map((minute) => ({
      eventKey: `e${minute}`,
      patientId: 'p1',
      type: 'vitals',
      data: {},
      output: { minute },
      ts: new Date(Date.UTC(2026, 0, 1, 0, minute)),
      receivedAt: new Date(),
      status: 'processed',
    }));

    const snapshots = replay(initialState, events);

    expect(snapshots.map((s) => s.stateAfter.eventCount)).toEqual([1, 2]);
    expect(snapshots[1].stateAfter.latestByType).toEqual({
      vitals: { minute: 2 },
    });
    expect(initialState.eventCount).toBe(0);
    expect(initialState.latestByType).toEqual({});
  });

  it('rejects events without an external output', () => {
    const event: EventDocument = {
      eventKey: 'e1',
      patientId: 'p1',
      type: 'vitals',
      data: {},
      ts: new Date(),
      receivedAt: new Date(),
      status: 'processed',
    };
    expect(() => replay(initialState, [event])).toThrow('Missing output');
  });
});

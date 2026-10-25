import type { EventDocument } from '../events/event.document.js';

export interface PatientState {
  eventCount: number;
  latestByType: Record<string, unknown>;
  asOf: Date | null;
}

export const initialState: PatientState = {
  eventCount: 0,
  latestByType: {},
  asOf: null,
};

// Applies a single event to the given patient state, returning the updated state.
export function applyEvent(
  state: PatientState,
  event: EventDocument,
): PatientState {
  if (event.output === undefined)
    throw new Error(`Missing output for event ${event.eventKey}`);
  return {
    eventCount: state.eventCount + 1,
    latestByType: {
      ...state.latestByType,
      [event.type]: event.output,
    },
    asOf: event.ts,
  };
}
// Replays a sequence of events starting from the given initial state, returning the state after each event.
export function replay(
  start: PatientState,
  events: EventDocument[],
): ReplayResult[] {
  let state = start;
  return events.map((event) => {
    state = applyEvent(state, event);
    return { eventKey: event.eventKey, stateAfter: state };
  });
}

export interface ReplayResult {
  eventKey: string;
  stateAfter: PatientState;
}

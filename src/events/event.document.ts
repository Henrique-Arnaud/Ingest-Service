import { PatientState } from "../processing/patient-state.js";

export type EventStatus = 'pending' | 'processing' | 'processed';

export interface EventDocument {
  /** Deterministic hash of the event identity; unique index makes retries idempotent. */
  eventKey: string;
  patientId: string;
  type: string;
  data: Record<string, unknown>;
  ts: Date;
  status: EventStatus;
  receivedAt: Date;
  leaseUntil?: Date;
  claimToken?: string;
  processedAt?: Date;
  output?: Record<string, unknown>;
  stateAfter?: PatientState;
}

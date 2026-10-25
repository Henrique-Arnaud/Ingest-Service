# Load test – 3000 patients/min for 3 minutes (800 worker slots)

Run date: 2026-10-22 (20:42:35Z → 20:45:47Z) · runId `load-1792701756086`

## Scenario

| Item | Value |
| --- | --- |
| Patients | 9,000 (3,000/min × 3 min) |
| Events per patient | 2 → 18,000 events (100 events/s) |
| Duplicates | 0% |
| Arrival order | shuffled (out-of-order within each patient) |
| Simulated processing | 5 s per event |
| Worker | `WORKER_CONCURRENCY=800`, `WORKER_POLL_MS=500`, lease 60 s |
| Docker VM | 2 CPUs, 1.45 GiB RAM |

Command:

```bash
PATIENTS=9000 EVENTS_PER_PATIENT=2 DUPLICATE_RATIO=0 RATE_PER_MIN=6000 \
DURATION_SECONDS=180 MAX_DRAIN_MS=1800000 node scripts/load-test.mjs
```

## Results

| Metric | Value |
| --- | --- |
| HTTP 202 | 18,000 / 18,000 (no errors or timeouts) |
| API latency p50 / p95 / p99 / max | 4.0 / 39.2 / 141.2 / 1,078.5 ms |
| Stored / processed | 18,000 / 18,000 |
| Lost / duplicated in DB | 0 / 0 |
| Snapshot mismatches (`stateAfter`, `output`) | **0** |
| Max pending (backlog) | 79 |
| Events in `processing` during the run | ~470–545 |
| Drain after sending | **10.4 s** |
| Total time | ~190 s |
| Mongo slow queries (>100 ms) in the run window | 153 (p95 442 ms, max 462 ms) |
| App ERROR / WARN logs | 0 / 0 |
| Peak CPU / memory: app | 25% / 202 MiB |
| Peak CPU / memory: mongo | 94% / 415 MiB |

`patientsWithOrderViolation = 4,453` only counts patients whose events *arrived*
out of order. It is a diagnostic, not a failure: replay rebuilt every snapshot
in `(ts, eventKey)` order, and all 18,000 snapshots matched.

## Analysis

The backlog did **not** grow during sending. It stayed between 10 and 79 pending events for the full 180 s.

Little's law predicts the required parallelism: 100 events/s × 5 s = **500 events in flight**. The `processing` count stayed at about 500 throughout, which matches that prediction. With 800 slots (ideal ceiling 800 / 5 = 160 events/s), about 300 slots were idle. The worker therefore ran at about 62% of its capacity and was never saturated.

So once in-flight work went above the ~500 needed, the system kept up with the incoming rate. The only leftover was the last ~5 s of events, which drained in 10 s.

## Comparison with previous runs (same scenario)

| Slots | Ideal ceiling | Max pending | Drain after send | Total | API p95 / p99 | Slow queries | Docker VM |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 200 (poll 1 s) | 40 ev/s | 12,163 | 385.7 s | 565.7 s | 132 / 306 ms | 1,779 | 1 CPU |
| 400 (poll 1 s) | 80 ev/s | 7,110 | 125.7 s | 305.7 s | 572 / 1,744 ms | 2,085 | 1 CPU |
| **800 (poll 0.5 s)** | 160 ev/s | **79** | **10.4 s** | **~190 s** | **39 / 141 ms** | **153** | 2 CPUs |

Caveat: this run had 2 CPUs and a 500 ms poll, while the earlier runs had 1 CPU and a 1 s poll. So the improvements in latency and slow queries are not due to concurrency alone. The removal of the backlog, however, is explained by capacity: 160 ev/s is above the 100 ev/s incoming rate.

## Observations and next steps

- Mongo was the busiest component (up to 94% of one CPU). Each commit replays the patient's full history in a transaction. That is cheap with 2 events per patient, but cost grows with history length.
- The 5 s handler is simulated with a timer. A real external system must also handle about 500 concurrent calls, or the slots will just move the bottleneck there.
- For more headroom, run more worker replicas. This is already safe: the unique partial index enforces one `processing` event per patient, and the claims are leased.

Raw artifacts (outside the repo): `load-c800-result.json`, `load-c800-app.log`,
`load-c800-mongo.log`, `load-c800-resources.log` in the session files folder.

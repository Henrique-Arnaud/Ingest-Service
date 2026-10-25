# Load test – 3000 patients/min for 3 minutes (incremental replay, 700 slots)

Run date: 2026-10-23 (12:05:59Z → 12:09:16Z) · runId `load-1792757165016`

## What changed since the previous run

| Item | Previous run (800 slots) | This run |
| --- | --- | --- |
| Replay in `commitReplay` | full patient history | **incremental** (from previous snapshot) |
| `WORKER_CONCURRENCY` | 800 | 700 |
| `WORKER_LEASE_MS` | 60,000 | 30,000 |
| `WORKER_POLL_MS` | 500 | 500 |
| `MONGO_MAX_POOL_SIZE` | driver default (100) | 100 |
| Docker VM | 2 CPUs, 1.45 GiB | 2 CPUs, 1.45 GiB |
| Documents in `events` before run | ~375k | ~375k (393,109 after) |

Same scenario: 9,000 patients × 2 events = 18,000 events at 100 events/s,
shuffled order, 0% duplicates, 5 s simulated processing.

## Results

| Metric | 800 slots, full replay | **700 slots, incremental replay** |
| --- | --- | --- |
| HTTP 202 | 18,000 / 18,000 | 18,000 / 18,000 |
| Stored / processed / lost | 18,000 / 18,000 / 0 | 18,000 / 18,000 / 0 |
| Snapshot mismatches | 0 | **0** |
| Max pending | 79 | 343 |
| `processing` during send | ~470–545 | ~400–604 |
| Drain after send | 10.4 s | **10.4 s** |
| API p50 / p95 / p99 / max | 4.0 / 39 / 141 / 1,079 ms | 9.4 / 387 / 1,004 / 2,345 ms |
| Mongo slow queries (>100 ms) | 153 | 5,176 (p95 353 ms, max 1,194 ms) |
| App ERROR / WARN | 0 / 0 | 0 / 0 |
| Peak CPU: app / mongo | 25% / 94% | 36% / 57% |

## Analysis

**Correctness and throughput hold.** All 18,000 snapshots matched. The backlog
never grew during sending, and the system drained 10.4 s after sending stopped,
the same as before. 700 slots (ideal ceiling 140 events/s) is enough for the 500
in-flight events Little's law requires (100 events/s × 5 s).

**This test cannot measure the incremental replay.** With 2 events per patient,
the full history read at most 2 documents, so there was little to save. Replay
reads were not where time went: of the 5,176 slow operations, only ~200 were
`find` on `{patientId, ts, eventKey}`.

**The extra latency came from plain writes.** The slowest operation types were:

| Operation | Count | Avg ms | Max ms |
| --- | --- | --- | --- |
| `commitTransaction` | 1,610 | 156 | 404 |
| `insert` (API `POST /events`) | 1,530 | 183 | 957 |
| `findAndModify` by `_id` (claim) | 1,355 | 196 | 596 |
| `update` (commit fence) | 371 | 173 | 1,194 |

These are single-document writes using the `_id` or `eventKey` index. When they
take ~150–200 ms while Mongo CPU stays below 60%, the cause is waiting on
storage: journal/majority-write flushes and WiredTiger cache pressure. Mongo had
a 1.45 GiB VM and indexes over ~390k documents. Query plans were not the cause,
and neither was the replay. Docker Desktop disk I/O on macOS also varies a lot
between runs. That is the most likely reason the 800-slot run, made under the
same scenario, was much quieter.

## Conclusion and next steps

- Incremental replay is a safe change with no regression in correctness or
  throughput. Its benefit shows up only when patients have long histories.
- To measure it, run an A/B test on the same build and data with many events per
  patient (e.g. `EVENTS_PER_PATIENT=50`, `PATIENTS=360`, sent in order). Compare
  commit latency and Mongo CPU.
- To reduce the API p95/p99:
  - start each run from an empty database (or drop old runs' data), so index size
    stays constant between runs;
  - give the Docker VM more memory for the WiredTiger cache;
  - repeat each configuration 2–3 times before drawing conclusions.

Raw artifacts (session files folder): `load-incr-result.json`, `load-incr-app.log`,
`load-incr-mongo.log`, `load-incr-resources.log`.

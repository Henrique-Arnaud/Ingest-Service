# Ten-minute soak with fault injection

Run: 2026-10-23 17:39:14Z–17:49:25Z · runId `load-1792777155947`

This report compares the run with the [five-minute fault-injection run](./fault-injection-soak-report.md).
Both are recovery smoke tests, not proof of hours- or days-long stability.

## Setup

- Dropped only the local `ingest` database before the run, then recreated its
  indexes by restarting the app.
- 30,000 synthetic patients × 2 events = 60,000 unique events over 600 seconds
  (100 events/s), shuffled arrival order, 0% intentional duplicates.
- `WORKER_CONCURRENCY=800`, `WORKER_LEASE_MS=30000`,
  `WORKER_POLL_MS=500`, `MONGO_MAX_POOL_SIZE=100`, simulated processing 5 s.
- Docker VM: 2 CPUs and 1.45 GiB RAM. Host load average: 2.64–6.23.
- The load client retried network failures, HTTP 5xx and 429 responses up to
  eight attempts, preserving the same event identity.

## Faults injected

| Approx. elapsed | Action | Observation |
| --- | --- | --- |
| 2:00 | Forced app stop (`docker compose stop --timeout 0`) | App restarted about 13 seconds later. Pending work accumulated while it was unavailable; after restart it resumed processing. |
| 5:00 | Restarted Mongo | Mongo returned healthy; the app continued processing. |
| 8:00 | Paused app for 15 seconds, then unpaused | Backlog rose briefly, then drained as processing resumed. |

## Results and comparison

| Metric | Five-minute run | **Ten-minute run** |
| --- | ---: | ---: |
| Unique events / target rate | 30,000 / 100 events/s | **60,000 / 100 events/s** |
| Final HTTP 202 | 30,000 / 30,000 | **60,000 / 60,000** |
| Attempts / retries | 38,890 / 8,890 | **69,094 / 9,094** |
| Retries per unique event | 29.6% | **15.2%** |
| Stored / processed | 30,000 / 30,000 | **60,000 / 60,000** |
| Lost / duplicated in Mongo | 0 / 0 | **0 / 0** |
| Snapshot mismatches | **0** | **0** |
| API p50 / p95 / p99 / max | 4 / 10,342 / 17,768 / 20,755 ms | **5 / 2,729 / 15,126 / 20,759 ms** |
| Max sampled pending | 1,450 | **4,510** |
| Max sampled `processing` documents | 1,063 | **1,325** |
| Pending at end of send window | 9 | **25** |
| Drain after sending stopped | 6.3 s | **8.6 s** |
| Mongo slow queries (>100 ms, in run window) | 132; p95 546 ms; max 585 ms | **277; p95 278 ms; max 36,334 ms** |
| Peak sampled app / Mongo CPU | 78% / 78% | **70% / 103%** |
| Peak sampled app / Mongo memory | 204 / 527 MiB | **202 / 614 MiB** |
| App ERROR / WARN | 0 / 0 | **0 / 36** |

All 36 warnings in the ten-minute run were `Lease lost` warnings: work claimed
by the stopped process could no longer commit after its lease was reclaimed.
The fenced transaction prevented stale writes. These warnings are expected
around forced termination; the final snapshot check still passed.

The 36.3-second Mongo outlier was an `_id`-indexed `findAndModify` at
17:42:17Z, during recovery from the app stop. It is a serious latency spike,
even though the request retries eventually succeeded. The slow-query summary
includes operations above Mongo's slow-query threshold and is not an API
request count.

## Interpretation

- **Correctness and eventual recovery held for both durations:** all accepted
  events were stored and processed, with no duplicate documents or snapshot
  mismatches.
- **The retry ratio was lower, but the longer run was not uniformly better.**
  Retries per event fell from 29.6% to 15.2%, and p95 fell from 10.3 s to 2.7 s;
  however p99 remained high at 15.1 s, max pending grew from 1,450 to 4,510,
  and Mongo had a single 36.3-second write/claim outlier. Faults occurred at
  different points in each run, so this is not a controlled statistical
  comparison; repeat runs are needed to establish whether the change is real.
- **The larger backlog follows interruptions plus retries.** After each fault,
  pending work rose and then fell; by the end of the 10-minute send window only
  25 events remained pending, and the total backlog drained in 8.6 seconds.
- **The `processing` count can exceed 800 during recovery.** Old leases remain
  in Mongo temporarily after a forced stop while the restarted worker claims
  other eligible patients. That count is not the restarted process's own
  in-memory concurrency.
- **Long-term stability is still unproven.** This run does not model sustained
  disk growth, cache/oplog pressure over days, growing per-patient histories,
  or a real external dependency.

Raw artifacts (session files folder): `10m-fault-result.json`,
`10m-fault-timeline.log`, `10m-fault-errors.log`, `10m-fault-app.log`,
`10m-fault-mongo.log`, and `10m-fault-resources.log`.

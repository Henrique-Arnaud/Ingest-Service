# Five-minute soak with fault injection

Run: 2026-10-23 17:18:21Z–17:23:29Z · runId `load-1792775902851`

This is a five-minute recovery smoke test, not evidence of multi-hour or
multi-day stability. The risks and long-run acceptance signals are listed in
[soak-test-risks.md](./soak-test-risks.md).

## Setup

- Dropped only the local `ingest` database before the run; it contained 18,000
  previous synthetic events. Mongo recreated its indexes when the app started.
- 15,000 synthetic patients × 2 events = 30,000 unique events over 300 seconds
  (100 events/s); shuffled arrival order, no intentional duplicates.
- `WORKER_CONCURRENCY=800`, `WORKER_LEASE_MS=30000`,
  `WORKER_POLL_MS=500`, `MONGO_MAX_POOL_SIZE=100`, simulated processing 5 s.
- Docker VM: 2 CPUs, 1.45 GiB RAM. Host load average sampled at 2.65–6.21.
- The load script was updated to retry transient transport failures, HTTP 5xx,
  and 429 responses up to 8 total attempts. Retries reuse the same event identity
  and are safe because event insertion is idempotent.

## Faults injected

| Approx. elapsed | Action | Observation |
| --- | --- | --- |
| 0:59 | Forced app container stop with zero-second timeout | App restarted about 13 s later. Queue/backlog rose as in-flight leases and incoming requests waited; processing recovered after restart. |
| 2:59 | Restarted the Mongo container | Mongo returned healthy and the app remained running. The sampled pending count rose briefly, then fell. |
| 3:59 | Paused the app container for 15 s, then unpaused it | Pending count peaked at 1,450 shortly after resume and fell to 9 by the end of the five-minute send window. |

## Results

| Metric | Result |
| --- | ---: |
| Unique events sent | 30,000 |
| Final HTTP 202 responses | 30,000 / 30,000 |
| Send attempts / retries | 38,890 / 8,890 |
| Stored / processed | 30,000 / 30,000 |
| Lost / duplicated in Mongo | 0 / 0 |
| Snapshot mismatches | **0** |
| API latency p50 / p95 / p99 / max (includes retries) | 4.4 / 10,342 / 17,768 / 20,755 ms |
| Max sampled pending | 1,450 |
| Max sampled `processing` documents | 1,063 |
| Pending at t=300 s | 9 |
| Drain after sending stopped | 6.3 s |
| Mongo slow queries during run (>100 ms) | 132 (p50 434 ms, p95 546 ms, max 585 ms) |
| Peak sampled app / Mongo CPU | 78% / 78% |
| Peak sampled app / Mongo memory | 204 MiB / 527 MiB |
| App ERROR / WARN entries | 0 / 0 |

The `processing` document count briefly exceeded 800 because a forced app stop
leaves the previous process's leased documents in Mongo until their 30-second
leases expire. The restarted process can claim other eligible patients in the
meantime. This is expected with lease-based recovery; the count is not the
restarted process's in-memory concurrency.

## Conclusion

The service recovered from all three interruptions and eventually processed
every event with correct snapshots. The retry policy prevented transient
outages from becoming failed requests, but made request latency during faults
high: p95 exceeded 10 seconds and each event required 1.30 attempts on average.
The backlog grew during outages and drained after service returned.

This does **not** establish uninterrupted availability or prove long-term
stability. It demonstrates eventual recovery for these specific short faults
under this five-minute synthetic workload. Longer soaks still need to track
disk/cache/oplog growth, memory trends, backlog age, and late-event replay cost.

Raw logs and results are in the session files folder: `fault-soak-result.json`,
`fault-soak-timeline.log`, `fault-soak-errors.log`, `fault-soak-app.log`,
`fault-soak-mongo.log`, and `fault-soak-resources.log`.

# Load test – 3000 patients/min for 3 minutes on a quiet host

Run: 2026-10-23 12:46:15Z → 12:49:28Z · runId `load-1792759577500`

Setup:
- `ingest` database dropped before the run.
- Most host apps closed. Host load average stayed at 3.4–4.3 on 8 cores; in the previous runs it was 8–48.
- Incremental replay.
- `WORKER_CONCURRENCY=800`, `WORKER_LEASE_MS=30000`, `WORKER_POLL_MS=500`, `MONGO_MAX_POOL_SIZE=100`.
- Docker VM with 2 CPUs and 1.45 GiB.

Scenario:
- 9,000 patients × 2 events = 18,000 events at 100 events/s.
- Events sent in shuffled order, 0% duplicates.
- 5 s simulated processing per event.

## Results

| Metric | Value |
| --- | --- |
| HTTP 202 | 18,000 / 18,000 (no timeouts) |
| Stored / processed / lost | 18,000 / 18,000 / 0 |
| Duplicates in DB / snapshot mismatches | 0 / **0** |
| API p50 / p95 / p99 / max | **3.7 / 30.6 / 63.1 / 372 ms** |
| Max pending | **60** |
| Events in `processing` | 467–552 (peak in-flight 562 of 800) |
| Drain after send | **10.3 s** (≈ 5 s processing + last poll and commits) |
| Mongo slow queries (>100 ms) | **4** (max 177 ms) |
| Peak CPU app / mongo | 33% / 99% |
| Peak memory app / mongo | 175 MiB / 380 MiB |
| App ERROR / WARN | 0 / 0 |

## Comparison (same scenario)

| Run | Slots | Host load | API p95 / p99 | Max pending | Drain | Slow queries |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-10-22, full replay | 800 | not sampled | 39 / 141 ms | 79 | 10.4 s | 153 |
| Incremental replay, ~375k docs | 700 | not sampled | 387 / 1,004 ms | 343 | 10.4 s | 5,176 |
| Clean DB #1 | 700 | ~48 | 4,312 / 7,056 ms | 3,124 | 38.5 s | 3,634 |
| Clean DB #2 | 700 | 8–14 | 1,096 / 2,967 ms | 1,038 | 16.9 s | 1,714 |
| **Clean DB, quiet host** | **800** | **3.4–4.3** | **31 / 63 ms** | **60** | **10.3 s** | **4** |

## Conclusions

- **Host contention was the main source of the bad numbers.** The build, data
  size and scenario were the same as the clean runs, and p95 dropped from 1–4 s
  to 31 ms. Slow queries dropped from thousands to 4. The earlier slow inserts
  and commits came from the Docker VM waiting on CPU and disk, not from the code.
- **800 slots are comfortable for 100 events/s.** Little's law needs ~500 events
  in flight. The run used at most 562, about 30% headroom. The backlog stayed
  under 60 for the whole run, and the system finished 10.3 s after the last
  request: the minimum possible is 5 s of processing plus a poll interval and
  the commits.
- **Correctness held in every run:** no lost or duplicated events, and every
  snapshot matched its chronological order.
- **Mongo is still the busiest component** (up to ~99% of one CPU on a 2-CPU VM).
  It is the first thing to scale for higher rates: more CPU and memory, then a
  cheaper claim query.

## How to reproduce comparable numbers

1. Close heavy apps and check `uptime` (load average well below the core count).
2. Drop the `ingest` database:
   `docker compose exec mongo mongosh ingest --eval 'db.dropDatabase()'`.
3. Restart the app so it recreates the indexes, then run the load script.

Raw artifacts (session files folder): `load-quiet-result.json`, `load-quiet-app.log`,
`load-quiet-mongo.log`, `load-quiet-resources.log`.

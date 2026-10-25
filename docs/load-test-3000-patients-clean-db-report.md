# Load test – 3000 patients/min for 3 minutes on a clean database

Runs: 2026-10-23, after `db.dropDatabase()` on `ingest` (indexes recreated on app start).

Same build and config as the [incremental replay run](load-test-3000-patients-incremental-replay-report.md):
incremental replay, `WORKER_CONCURRENCY=700`, `WORKER_LEASE_MS=30000`,
`WORKER_POLL_MS=500`, `MONGO_MAX_POOL_SIZE=100`, Docker VM with 2 CPUs and 1.45 GiB.
Scenario: 9,000 patients × 2 events = 18,000 events at 100 events/s, shuffled,
0% duplicates, 5 s simulated processing.

## Results

| Metric | Previous run (~375k docs) | Clean run #1 | **Clean run #2** |
| --- | --- | --- | --- |
| Start (UTC) | 12:05:59 | 12:15:56 | 12:23:16 |
| HTTP 202 | 18,000 | 16,473 (1,527 client timeouts) | **18,000** |
| Stored / processed | 18,000 / 18,000 | 17,972 / 17,972 | **18,000 / 18,000** |
| Lost (never stored) | 0 | 28 (all timed out, none got 202) | **0** |
| Snapshot mismatches | 0 | 0 | **0** |
| Max pending | 343 | 3,124 | 1,038 |
| Drain after send | 10.4 s | 38.5 s | 16.9 s |
| API p50 / p95 / p99 | 9 / 387 / 1,004 ms | 81 / 4,312 / 7,056 ms | 11 / 1,096 / 2,967 ms |
| Mongo slow queries | 5,176 | ~3,600 | 1,714 (p95 1,380 ms) |
| Peak CPU app / mongo | 36% / 57% | 101% / 215% | 82% / 110% |
| Host load average (8 cores) | not sampled | **~48** at end of run | 8–14 |
| App ERROR / WARN | 0 / 0 | 0 / 0 | 0 / 0 |

## What the clean runs show

1. **Correctness was not affected.** In every run, every event that got a 202 was
   stored and processed exactly once, and all snapshots matched. In run #1, 1,499
   of the 1,527 timed-out requests were still stored, because the server finished
   the insert after the client gave up. The other 28 never reached the database.
   The load script does not retry, so it never resent those 28.
2. **Database size was not the bottleneck.** The data is tiny (`ingest` ≈ 6 MB
   after a run). Cleaning it made no consistent difference. Run #1 was the worst
   of all, run #2 was in between.
3. **The variance comes from the host machine.** During run #1 the Mac (8 cores)
   had a load average of about 48 and almost no free RAM. Busy processes included
   VS Code and Copilot, `git`, Microsoft Defender, Logitech G Hub, and a Node app
   from another project. Docker's VM competes with all of them for CPU and disk.
   That explains why identical configurations give p95 from 39 ms to 4.3 s.
4. **700 slots have little margin when commits slow down.** Each slot is held for
   the 5 s of processing plus the commit time. At about 1–2 s per commit, 100
   events/s needs about 650 slots or more, close to the limit of 700. In run #2,
   `processing` stayed at 700 from t=140–180 s and the backlog rose to 1,038. With
   800 slots, the previous day's run kept the backlog under 79.
5. **The oplog keeps growing.** The replica-set oplog (`local` db) held ~1.28M
   entries (~700 MB) from earlier runs, and dropping `ingest` does not clear it.
   WiredTiger's cache is only 256 MB in a 1.45 GiB VM. This does not change the
   results, but it adds memory and disk pressure over time.

## Recommendations

- For reproducible numbers, close heavy apps during runs and give Docker more
  memory (≥ 3 GiB). Repeat each configuration 2–3 times, and record host load
  with the result (the sampler now logs it).
- Keep about 30–60% headroom over Little's law: `WORKER_CONCURRENCY ≈ 800` for
  100 events/s.
- Optionally cap the oplog for local runs:
  `db.adminCommand({ replSetResizeOplog: 1, size: 1024 })` (MB).
- Make the load script retry timed-out requests. That matches how a real client
  behaves, and the idempotent `eventKey` makes resending safe.

Raw artifacts (session files folder): `load-clean-*` (run #1) and
`load-clean2-*` (run #2): result JSON, app/mongo logs, resource samples.

# 3,000 patients/minute for three minutes — 400 worker slots

## Conclusion

**Delivery and final-state integrity passed; sustained processing capacity did not.** Increasing concurrency from 200 to 400 significantly shortened processing and backlog drain, but the queue still grew during traffic.

## Scenario

- Date: October 22, 2026.
- Run: `load-1792690477720`.
- Start: 14:34:37.720 UTC-3; approximate finish: 14:39:43.420 UTC-3.
- 9,000 patients, two unique events each: **18,000 events**.
- Sending window: 180 seconds, equivalent to 3,000 two-event patients/minute or **100 events/s**.
- Patients and their events were randomly interleaved, not partitioned into exact patient-arrival batches per minute.
- No duplicate retries; client timeout 10 seconds.
- One API + worker instance, concurrency **400** verified in startup logs.
- Processing delay 5 seconds; lease 60 seconds; polling 1 second.
- MongoDB 8 single-node replica set.
- Docker VM: **1 CPU, 1,558,749,184 bytes RAM (approximately 1.45 GiB)**, matching the previous 200-slot run's reported VM resources.
- Existing data preserved; each run uses exclusive patient IDs. Prior run data remains in the database, so this is not an identical database baseline.
- Generator and containers share the local host.

## Results and comparison

| Metric | Previous: 200 slots | Current: 400 slots |
|---|---:|---:|
| HTTP 202 responses | 18,000 / 18,000 | **18,000 / 18,000** |
| Client errors | 0 | **0** |
| Persisted / processed | 18,000 / 18,000 | **18,000 / 18,000** |
| Missing / duplicate event keys | 0 / 0 | **0 / 0** |
| Snapshot mismatches | 0 | **0** |
| HTTP latency p50 | 5.7 ms | 6.6 ms |
| HTTP latency p95 | 132.3 ms | 572.0 ms |
| HTTP latency p99 | 305.9 ms | 1,743.8 ms |
| Maximum HTTP latency | 892.7 ms | 2,656.4 ms |
| Sending duration | 180.0 s | 180.0 s |
| Additional drain | 385.7 s | **125.7 s** |
| Total duration | 565.7 s | **305.7 s** |
| Largest sampled pending queue | 12,163 | **7,110** |
| Processed near t=180 s | 5,637 | **10,490** |
| Estimated peak concurrency | 200 | **400** |
| Generator exit code | 0 | **0** |

Drain time decreased approximately **67.4%**; total duration decreased **46.0%**. Average completion throughput over the full run rose from approximately 31.8 to **58.9 events/s**, about 1.85 times higher. These include startup/drain, not just steady-state throughput.

HTTP tail latency worsened while processing throughput improved. More concurrency generates additional database work; this observation alone does not establish the exact cause of the latency increase.

## Backlog timeline

| Seconds | Pending | Processing | Processed |
|---|---:|---:|---:|
| 10 | 202 | 398 | 400 |
| 170 | 6,911 | 0 | 10,090 |
| 180 | 7,110 | 400 | 10,490 |
| 190 | 6,310 | 400 | 11,290 |
| 200 | 5,910 | 400 | 11,690 |
| 300 | 0 | 11 | 17,989 |
| Final | 0 | 0 | 18,000 |

These are approximate ten-second samples. A zero processing count can capture a gap between completed batches and the next claim, not a stopped worker. The largest sampled queue is not necessarily the true instantaneous maximum.

Near the end of sending, **7,510 events** were still pending or processing. The service accepted the burst but needed another **2 minutes 5.7 seconds** to finish.

At 400 slots, external waiting alone imposes an ideal ceiling:

```text
400 / 5 seconds = 80 events/s
Incoming load  = 100 events/s
```

Therefore 400 slots cannot sustain this workload even without database and scheduling overhead. At least 500 slots would be occupied by external waiting alone; the actual required configuration needs additional capacity and validation.

## Correctness

All 18,000 documents were processed, with no missing events, duplicate event keys or mismatched snapshots. For 2,988 patients, completion order differed from event-time order; replay corrected the snapshots of the stored history.

No crashes, multiple worker replicas or deliberate lease takeovers were injected.

## Logs and resources

- Generator error log: empty.
- Application log entries containing `ERROR` / `WARN`: **0 / 0**.
- MongoDB `Slow query` entries during this execution: **2,085**.
- Maximum slow-query duration: **1,881 ms**.

| First command field in slow-query entries | Count |
|---|---:|
| `update` | 585 |
| `findAndModify` | 410 |
| `commitTransaction` | 386 |
| `q` | 307 |
| `insert` | 288 |
| `find` | 77 |
| `aggregate` | 32 |

These are log entries, not failed operations or HTTP requests. `q` is reported as recorded, without assigning it a separate public-operation meaning.

16 samples per container were recorded, starting approximately 30 seconds into execution:

| Container | Sampled CPU | Sampled memory |
|---|---:|---:|
| API + worker | 0.86–39.88% | 166.9–178.3 MiB |
| MongoDB | 2.51–73.88% | 299.3–486.8 MiB |

These ranges describe collected samples, not certified peaks. Application logs do not provide a complete per-request audit or pool-wait breakdown.

## Reproduction

The source configuration default was already changed to 400 before this execution. Rebuild the image to use it; an explicit `WORKER_CONCURRENCY` setting takes precedence.

```bash
docker compose up -d --build --wait app

PATIENTS=9000 \
EVENTS_PER_PATIENT=2 \
DUPLICATE_RATIO=0 \
RATE_PER_MIN=6000 \
DURATION_SECONDS=180 \
MAX_DRAIN_MS=1800000 \
node scripts/load-test.mjs
```

`DURATION_SECONDS` overrides the rate for scheduling. Final processing continues after the sending window. This is a single short local run, not production certification.

Previous baseline: [200-slot report](load-test-3000-patients-report.md).

# Load test: 3,000 patients/minute for three minutes

## Conclusion

**Ingestion and persisted-state integrity passed; sustained processing capacity did not.** All 18,000 requests received HTTP 202, all events were persisted and eventually processed, and every snapshot matched the expected chronological state. However, the pending backlog grew to 12,163 in the samples and required another 6 minutes 25.7 seconds to drain.

This configuration can accept this three-minute burst but cannot sustain its processing rate indefinitely.

## Environment and method

- Date: October 22, 2026.
- Run ID: `load-1792688990367`.
- Start: 14:09:50.367 UTC-3; approximate end: 14:19:16.067 UTC-3.
- Docker VM: **1 CPU**, 1,558,749,184 bytes of RAM (approximately 1.45 GiB).
- One NestJS API + worker instance; MongoDB 8, single-node replica set.
- Worker concurrency 200; simulated external processing 5 seconds; polling 1 second; lease 60 seconds.
- 9,000 distinct patients, two unique events per patient: **18,000 events**.
- Requests scheduled over 180 seconds: **100 events/s**, or 6,000 events/minute, equivalent to 3,000 two-event patients/minute by total volume.
- Events were randomly interleaved across patients. This does not enforce exactly 3,000 previously unseen patient IDs in each wall-clock minute.
- No duplicate retries; HTTP client timeout 10 seconds.
- Existing data was preserved. Verification filtered only this run's patient-ID prefix.
- The generator and Docker shared the local machine.

The previous 10,000-patients/minute test used a Docker VM with 2 CPUs and approximately 2.86 GiB RAM. These environments are different, so the results are not a controlled capacity comparison.

## Results

| Metric | Result |
|---|---:|
| Requests attempted | 18,000 |
| HTTP 202 responses | **18,000 / 18,000** |
| Client failures | **0** |
| Events persisted | **18,000 / 18,000** |
| Events eventually processed | **18,000 / 18,000** |
| Missing events | **0** |
| Duplicate event keys | **0** |
| Patients with both events stored | **9,000 / 9,000** |
| Snapshot mismatches | **0 / 18,000** |
| Request-phase duration | 180.0 s |
| Additional drain time | **385.7 s** |
| Total approximate duration | **565.7 s (9 min 25.7 s)** |
| Largest sampled pending backlog | **12,163** |
| Estimated peak concurrency | 200 |
| Generator exit code | 0 |

The generator's successful exit confirms its delivery and final-state checks, not the ability to process continuously at the incoming rate.

### HTTP latency

| Metric | Milliseconds |
|---|---:|
| p50 | 5.7 |
| p95 | 132.3 |
| p99 | 305.9 |
| Maximum | 892.7 |

There were no failed requests excluded from these percentiles. These are observed results, not an agreed latency SLO.

## Backlog

| Seconds after start | Pending | Processing | Processed |
|---|---:|---:|---:|
| 10 | 608 | 200 | 200 |
| 30 | 1,964 | 200 | 837 |
| 50 | 3,366 | 200 | 1,437 |
| 170 | 11,570 | 200 | 5,237 |
| 180 | 12,163 | 200 | 5,637 |
| 190 | 11,963 | 0 | 6,037 |
| 200 | 11,563 | 200 | 6,237 |
| 560 | 0 | 163 | 17,837 |
| Final | 0 | 0 | 18,000 |

Samples are collected approximately every 10 seconds. The request-phase clock and sampling clock are not exactly synchronized. The last row is the final verification, not a periodic sample.

At approximately the end of sending, only 5,637 events had completed, while 12,363 were pending or processing. The backlog decreased after the sender stopped.

Total throughput over the entire run was approximately **31.8 processed events/s**, including startup and drain. That is not a measurement of instantaneous maximum throughput.

### Capacity explanation

With 200 slots occupied for at least 5 seconds each:

```text
Ideal processing ceiling = 200 / 5 = 40 events/s
Incoming load           = 100 events/s
Minimum waiting slots   = 100 * 5 = 500
```

The configured concurrency cannot match this input rate even before claim, transaction and polling overhead. At the ideal ceiling, pending work would accumulate at approximately 60 events/s; observed overhead further reduces effective throughput.

500 slots is a theoretical minimum for external waiting alone, not a validated configuration recommendation. Increasing concurrency needs a new load test and sufficient database, CPU, memory and external-system capacity.

## Replay correctness

1,607 patients had processing completions out of chronological event-time order. This is expected with shuffled arrivals. **All 18,000 stored snapshots matched the expected chronological state**, showing that replay corrected the state for this run.

The test did not inject crashes, lease takeover or competing worker instances. Those scenarios are not certified by this execution.

## Logs

### Application and generator

- Application log entries containing `ERROR`: **0**.
- Application log entries containing `WARN`: **0**.
- Generator error log: empty.

The application logs are not a full per-request audit trail; final database verification and client results provide the delivery checks here.

### MongoDB

Within the execution window, **1,779 `Slow query` log entries** were recorded, with a maximum duration of **2,128 ms**.

| First command field in slow-query entries | Count |
|---|---:|
| `update` | 685 |
| `commitTransaction` | 421 |
| `q` | 396 |
| `findAndModify` | 156 |
| `insert` | 53 |
| `aggregate` | 41 |
| `find` | 27 |

These are log-entry counts, not distinct failed requests. `q` identifies the first command field recorded in that category and is not interpreted as a separate public operation. Slow operations indicate latency under contention, but these logs alone do not isolate a single bottleneck.

## Resource samples

31 samples per container were collected, starting about 30 seconds after launch and continuing through most of the execution:

| Container | Sampled CPU range | Sampled memory range |
|---|---:|---:|
| API + worker | 0.35–36.18% | 169.3–197.4 MiB |
| MongoDB | 3.26–72.91% | 346.7–529.6 MiB |

These are minimum/maximum values among the collected samples, not certified peaks of the complete execution. Sampling and the local generator also consume resources.

## Recommended next step

Measure increased concurrency and/or separate worker replicas gradually, while retaining snapshot verification. Instrument claim latency, pool waits, transaction duration and queue age. Do not interpret successful HTTP acceptance as proof that the processing rate is sustainable.

A broker can help decouple ingestion and manage backlog, but does not replace the processing capacity required for 100 events/s.

## Reproduction

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

`DURATION_SECONDS` overrides the request rate when scheduling the full queue. The script waits for final processing after the three-minute sending phase. It does not delete existing events.

This is one short local run, not a production benchmark or a test of hours-long sustained traffic.

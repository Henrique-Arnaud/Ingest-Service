# Long-running soak test: risk table

This table summarizes risks that a short load test cannot rule out. Estimates
are workload-dependent and should be verified against production-shaped data
and observed storage growth.

| Risk | Why a short benchmark may miss it | What to monitor or test | Mitigation |
| --- | --- | --- | --- |
| Disk growth | Processed events and indexes are retained; usage accumulates over time. | Database and volume size, growth per hour/day, free disk, oplog size. | Define retention and archival policies; alert on disk headroom. |
| Index and cache pressure | Growing collections and indexes increase working-set size and can turn memory hits into disk reads. | WiredTiger cache occupancy/dirty bytes, disk I/O, query latency, slow-query rate. | Size Mongo memory appropriately; keep hot indexes efficient; test with production-scale history. |
| Oplog growth and recovery window | Replica-set writes continually consume oplog capacity; a small time window can limit recovery after downtime. | Oplog size and time span, replication lag, restart/recovery duration. | Configure oplog capacity for the required recovery window and disk budget. |
| Application memory leak | Gradual retained objects or unbounded in-memory work may not appear in a few-minute run. | Container RSS, Node heap, event-loop delay, in-flight work over hours. | Bound queues and concurrency; investigate sustained upward memory trends. |
| Mongo or disk saturation | A brief run may not expose contention as data size or write volume rises. | CPU, disk latency/IOPS, connection-pool waits, Mongo operation latency, pending backlog. | Scale the constrained resource; reduce write amplification; load-test with realistic data. |
| Long patient histories and late events | Incremental replay is cheap for in-order events, but a late event must rebuild every later snapshot. | Replay tail length and duration, late-event rate, per-patient history distribution. | Use retention/checkpointing or a state model appropriate to the required correction window. |
| Backlog growth | A system can pass a short run while average processing capacity is only slightly above arrival rate. | Pending count and oldest-event age, accepted/processed rates, drain time. | Keep capacity headroom and alert when backlog or age trends upward. |
| Crash/restart behavior | Normal processing does not exercise lease expiry, transaction retry, or recovery after an outage. | Inject app termination and Mongo restart; verify eventual processing and snapshots. | Test fenced leases and idempotent external effects; use bounded retries and alerting. |
| Client timeouts and ambiguous outcomes | A client timeout does not prove the server failed to store the event. | HTTP outcome, retries, duplicate responses, stored event count by run. | Retry with a stable idempotency key; distinguish accepted, failed, and unknown outcomes. |
| External dependency degradation | The local handler simulates delay and does not represent real dependency limits or failures. | Dependency latency, errors, throttling, concurrent requests, retry volume. | Set timeouts, backoff, circuit breakers, and concurrency limits aligned with the dependency. |

## Long-run acceptance signals

For a soak test to provide evidence of sustained stability, trend metrics over
time rather than relying on a single average:

- pending count and age remain bounded;
- processed rate keeps pace with accepted rate;
- p95/p99 latency does not trend upward;
- app memory, Mongo cache pressure, disk usage, and oplog usage remain within
  planned limits;
- after injected outages, the service recovers and drains without lost events
  or incorrect state snapshots.

A five-minute fault-injection run is a recovery smoke test, not proof that the
system can operate safely for hours or days.

# Ingest Service — Test Assignment

This repository contains the implementation of the Ingest Service as part of a test assignment. The service is responsible for ingesting clinical data from a external service, processing it for 5 seconds, and saving it on our MongoDB database.

The implementation favors a modular monolith and the official MongoDB Node.js driver to keep the code easy to follow. MongoDB provides durable event storage and work claiming, so no separate message broker is required for the current scope.

The current application was run and tested locally using Docker on a macbook pro 2021 M1 chip, on a 2 cpu and 1.5gb ram docker machine.

## Run locally

Docker and Docker Compose are the only requirements for the standard workflow:

```bash
docker compose up --build
```

The API listens on <http://localhost:3000>. MongoDB is available only on
`127.0.0.1:27017`.

Run the test service against a real local MongoDB replica set:

```bash
docker compose run --rm test
```

Current worktree caveat: Vitest discovers several zero-byte `*.spec.ts` files
under `src/` and reports “No test suite found.” Populate or remove those
placeholder files before expecting the complete unit-test command to pass.

Example request:

```bash
curl -i -X POST http://localhost:3000/events \
  -H 'content-type: application/json' \
  -d '{"patientId":"p1","type":"heart-rate","data":{"bpm":80},"ts":"2026-01-01T10:00:00Z"}'
```

The endpoint returns `202 Accepted` with `{ "duplicate": false }` for a new
event, or `{ "duplicate": true }` if the same event identity was already
accepted.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP listen port |
| `MONGO_URI` | `mongodb://localhost:27017` | MongoDB connection string; Compose overrides this for the app |
| `MONGO_DB` | `ingest` | Database name |
| `MONGO_MAX_POOL_SIZE` | `100` | MongoDB driver's maximum connections per server in the application pool |
| `WORKER_ENABLED` | `true` | Enable background processing in this process |
| `WORKER_CONCURRENCY` | `800` | Maximum number of events held in memory as in-flight by one worker process |
| `WORKER_LEASE_MS` | `30000` | Duration of a claimed-event lease |
| `WORKER_POLL_MS` | `500` | Delay between worker claim cycles |
| `PROCESSING_MS` | `5000` | Simulated handler duration |

Defaults are development/benchmark settings, not production sizing advice.
Pool size, worker concurrency, lease duration, CPU, memory and MongoDB capacity
must be tuned together using representative workloads.

## API and health check

- `POST /events`: validates and durably inserts an event as `pending`, then
  returns `202`. Processing is not performed in the request.
- `GET /health`: pings MongoDB and returns `{ "status": "ok" }` when the ping
  succeeds. This is a dependency check, not a complete readiness or worker
  backlog assessment.

## Project layout

```text
src/
  config/       Environment configuration
  database/     MongoClient and database providers
  events/       HTTP endpoint, validation, idempotency and persistence
  processing/  Worker, handler and patient-state replay
  health/       MongoDB ping endpoint
test/           MongoDB-backed end-to-end tests
scripts/        Load and benchmark tools
docs/           Architecture, operational risks and benchmark reports
```

## Documentation

- [Architecture, decisions, fixes and roadmap](docs/architecture-and-decisions.md)
- [Long-running soak-test risks](docs/soak-test-risks.md)
- [Five-minute fault-injection report](docs/fault-injection-soak-report.md)
- [Ten-minute fault-injection report](docs/10-minute-fault-soak-report.md)
- [Three-minute run on a quiet host](docs/load-test-3000-patients-quiet-host-report.md)

## Run a load test

With the app and MongoDB running, execute:

```bash
PATIENTS=9000 \
EVENTS_PER_PATIENT=2 \
RATE_PER_MIN=6000 \
DURATION_SECONDS=180 \
DUPLICATE_RATIO=0 \
MAX_DRAIN_MS=1800000 \
node scripts/load-test.mjs
```

`DURATION_SECONDS`, when nonzero, determines the send duration and event rate;
`RATE_PER_MIN` is used by the script when no fixed duration is supplied.
Transient network errors, HTTP 5xx and 429 responses are retried up to
`MAX_SEND_ATTEMPTS` (default `8`) using the same event identity. The script
reports send attempts, retries, HTTP outcomes, latency, stored/processed
counts, queue samples and snapshot mismatches. Its patient IDs are unique per
run; it does not delete existing data.

The reports in `docs/` are individual local benchmark runs. They are useful
observations, not production capacity guarantees. In particular, the
five- and ten-minute fault tests demonstrate recovery from specific injected
interruptions, not multi-day stability.

## Important limitations

- The external handler is simulated. Real dependencies need timeouts,
  idempotency, backoff, rate limits and operational monitoring.
- MongoDB is a durable work queue in this design. It does not provide the
  isolation, replay tooling or independent scaling of a dedicated broker.
- The local single-node replica set enables transactions but is not highly
  available.
- Processed events are retained indefinitely; define retention and archival
  before long-running production use.
- See the [architecture guide](docs/architecture-and-decisions.md) for the
  consistency model, known gaps and prioritized improvements.

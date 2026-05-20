# Bio Swarm

Bio Swarm is an MVP architecture for a decentralized biomedical AI network:

- iPhone-first mobile app acts as an edge node.
- Cloud orchestrator coordinates tasks and validates results.
- Edge runtime executes small parallelizable compute tasks.
- Shared schemas keep contracts consistent across packages.

## Project Boundary

This project is strictly isolated from other workspace projects.

- Do not share code, packages, configs, env files, build outputs, or infrastructure.
- Keep all Bio Swarm artifacts only inside this repository folder.

## Vision and Strategy

- Product vision (HU): `infra/PRODUCT_VISION_HU.md`

## Monorepo Layout

- `apps/mobile`: Expo React Native app (iPhone-facing client)
- `apps/orchestrator`: Fastify TypeScript API for task orchestration
- `packages/shared`: shared domain types and validation helpers
- `packages/edge-runtime`: worker runtime for edge task execution
- `infra`: architecture notes and compliance placeholders

## Core Architecture

### Edge Compute Layer

Phones execute only lightweight work units such as:

- molecule scoring prefilter
- embedding generation mock
- hypothesis ranking
- biomedical data preprocessing

Execution is allowed when policy permits:

- charging
- wifi connected
- idle mode
- explicit user opt-in

### Cloud Layer

The orchestrator performs:

- task queueing and leasing
- node coordination and telemetry aggregation
- quorum validation from multiple independent node results
- heavy model and simulation handoff (future)

## Threat Model (MVP)

- Untrusted edge nodes may submit wrong results.
- Result poisoning is reduced using quorum checks and checksum signatures.
- PII should never be distributed to edge tasks.
- Biomedical decisions are not automated in this MVP.

## Biomedical Safety and Compliance Roadmap

1. Add data classification and de-identification controls.
2. Add audit logs and traceability for all compute units.
3. Introduce quality gates for reproducibility and bias checks.
4. Prepare HIPAA/GDPR impact assessment and legal review.
5. Define human-in-the-loop review for all actionable outputs.

## Quick Start

1. Install dependencies:

   ```bash
   pnpm install
   ```

2. Start all services in development mode:

   ```bash
   pnpm dev
   ```

3. Start only orchestrator:

   ```bash
   pnpm --filter @bio-swarm/orchestrator dev
   ```

4. Start edge runtime simulator:

   ```bash
   pnpm --filter @bio-swarm/edge-runtime dev
   ```

4a. Start orchestrator only via shortcut:

   ```bash
   pnpm dev:orchestrator
   ```

4b. Start edge runtime only via shortcut:

   ```bash
   pnpm dev:edge
   ```

4c. Start orchestrator + edge together:

   ```bash
   pnpm dev:stack
   ```

5. Run tests:

   ```bash
   pnpm test
   ```

6. Run smoke checks (orchestrator + edge-runtime test suites):

   ```bash
   pnpm smoke
   ```

7. Run end-to-end smoke (starts services, submits task, verifies processing):

   ```bash
   pnpm smoke:e2e
   ```

## API Endpoints (MVP)

- `POST /tasks` (requires header `x-admin-key: <ADMIN_API_KEY>`)
- `GET /tasks?state=pending|leased|completed|failed&limit=20`
- `GET /tasks/:id`
- `GET /tasks/:id/results?limit=50`
- `GET /tasks/:id/verdicts?limit=50`
- `GET /tasks/claim?nodeId=...`
- `POST /tasks/:id/result`
- `POST /tasks/:id/cancel` (requires header `x-admin-key: <ADMIN_API_KEY>`)
- `POST /tasks/:id/requeue` (requires header `x-admin-key: <ADMIN_API_KEY>`)
- `GET /nodes?active=true|false&limit=50`
- `GET /nodes/:id`
- `GET /nodes/:id/stats`
- `POST /nodes/:id/heartbeat`
- `GET /telemetry`
- `GET /admin/verdicts?limit=20&accepted=true&taskId=...` (requires header `x-admin-key: <ADMIN_API_KEY>`)
- `GET /admin/status` (requires header `x-admin-key: <ADMIN_API_KEY>`)
- `GET /admin/audit?limit=50&nodeId=...&taskId=...&eventType=...&since=...&until=...` (requires header `x-admin-key: <ADMIN_API_KEY>`)
- `GET /admin/audit/export?format=jsonl|csv&limit=50&nodeId=...&taskId=...&eventType=...&since=...&until=...` (requires header `x-admin-key: <ADMIN_API_KEY>`)

Audit event types include: `task_created`, `task_claimed`, `task_canceled`, `task_requeued`, `result_submitted`, `result_rejected`, `heartbeat_received`, `lease_expired`.

## Runtime Env Vars

Orchestrator:
- `PORT` (default `4000`)
- `LEASE_TTL_MS` (default `30000`)
- `MAX_TASK_ATTEMPTS` (default `4`)
- `ADMIN_API_KEY` (required for `/admin/*` endpoints)
- `ADMIN_RATE_LIMIT_MAX` (default `60` requests/window per IP)
- `ADMIN_RATE_LIMIT_WINDOW_MS` (default `60000`)
- `AUDIT_LOG_PATH` (default `./data/audit-log.jsonl`)
- `AUDIT_LOG_MAX_BYTES` (default `5000000`)
- `AUDIT_LOG_MAX_FILES` (default `5`)
- `AUDIT_LOG_RETENTION_DAYS` (default `30`, rotated files older than this are removed)

Edge runtime:
- `ORCHESTRATOR_URL` (default `http://localhost:4000`)
- `NODE_ID` (default random `node-xxxxxxxx`)

## Next Milestones

- Background task execution for iOS with real power/network constraints.
- Signed work units and verifiable compute proofs.
- Redis backed queue and persistent telemetry.
- Federated training experiments for biomedical embeddings.

## CI and Release Automation

- CI workflow: `.github/workflows/ci.yml`
   - Runs on push and pull request.
   - Executes `pnpm smoke` and `pnpm smoke:e2e`.

- Release workflow: `.github/workflows/release.yml`
   - Runs on tag push matching `v*` or manual dispatch.
   - Executes `pnpm test` and `pnpm build`.
   - Uploads build outputs as workflow artifacts.

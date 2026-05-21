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

Desktop GPU nodes handle heavier task-level inference units such as `llm_inference`.
`llm_inference` tasks are routed only to desktop GPU nodes that explicitly advertise central LLM host capability and, when requested, the matching `modelVersion`.
Workers can also run centrally managed package tasks via `package_execute`.
`package_execute` accepts either `packageId` or `packageName` (+ optional `packageVersion`) and workers cache downloaded packages in-memory by `packageId`. Optional package `signature` can be passed in task payload.
For safety, package execution is blocked when runtime is unsupported or when package content contains dangerous Node API usage patterns (for example `child_process`, `fs`, `net`, `dns`, `process.env`).
When package signing is enabled, workers verify package signatures (`hmac-sha256`) before execution.
Packages can declare explicit permissions (`filesystem`, `network`, `environment`), and workers enforce these declarations against content inspection and runtime policy.
Workers can run in hardened agent modes (`full`, `mobile_safe`, `package_worker`, `llm_central`) that restrict claimable and executable task kinds.

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

When task signing is enabled, the orchestrator signs task envelopes and workers verify them before execution.
The orchestrator can also persist queue, node, worker and package registry state to a local snapshot file and restore it on restart.

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

   If an orchestrator is already healthy at `ORCHESTRATOR_URL` (default `http://127.0.0.1:4000`), the script reuses it instead of starting a second instance.

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

   This live check also verifies task and node observability endpoints, including admin-protected audit routes.

## API Endpoints (MVP)

- `POST /tasks` (requires header `x-admin-key: <ADMIN_API_KEY>`)
- `GET /tasks?state=pending|leased|completed|failed&limit=20`
- `GET /tasks/:id`
- `GET /tasks/:id/results?limit=50`
- `GET /tasks/:id/verdicts?limit=50`
- `GET /tasks/:id/audit?limit=50&eventType=...&since=...&until=...` (requires header `x-admin-key: <ADMIN_API_KEY>`)
- `GET /tasks/claim?nodeId=...`
- `POST /tasks/:id/result`
- `POST /tasks/:id/cancel` (requires header `x-admin-key: <ADMIN_API_KEY>`)
- `POST /tasks/:id/requeue` (requires header `x-admin-key: <ADMIN_API_KEY>`)
- `DELETE /tasks/:id` (requires header `x-admin-key: <ADMIN_API_KEY>`)
- `GET /nodes?active=true|false&limit=50` (returns node stats, capabilities, activity flag, and control state)
- `GET /nodes/:id`
- `GET /nodes/:id/audit?limit=50&eventType=...&since=...&until=...` (requires header `x-admin-key: <ADMIN_API_KEY>`)
- `GET /nodes/:id/stats`
- `POST /nodes/:id/heartbeat`
- `POST /nodes/:id/disable` (requires header `x-admin-key: <ADMIN_API_KEY>`)
- `POST /nodes/:id/quarantine` (requires header `x-admin-key: <ADMIN_API_KEY>`)
- `POST /nodes/:id/enable` (requires header `x-admin-key: <ADMIN_API_KEY>`)
- `GET /telemetry`
- `GET /admin/verdicts?limit=20&accepted=true&taskId=...` (requires header `x-admin-key: <ADMIN_API_KEY>`)
- `GET /admin/status` (requires header `x-admin-key: <ADMIN_API_KEY>`, returns task/node/worker summaries, recent worker snapshots, recent verdicts, recent audit items, and audit/state persistence status)
- `GET /admin/dashboard` (requires header `x-admin-key: <ADMIN_API_KEY>`, highlights attention tasks and nodes for operators with reason-specific metrics)
- `GET /admin/dashboard/ui` (browser UI shell for operators; enter admin key in page to fetch `/admin/dashboard`)
- `POST /packages` (requires header `x-admin-key: <ADMIN_API_KEY>`, registers or updates a worker package by name+version with checksum, optional signature, and declared permissions)
- `GET /packages?limit=50` (requires header `x-admin-key: <ADMIN_API_KEY>`, lists registered worker packages)
- `GET /packages/:id` (requires header `x-admin-key: <ADMIN_API_KEY>`, returns package metadata + content + optional signature fields)
- `GET /packages/resolve?name=...&version=...` (requires header `x-admin-key: <ADMIN_API_KEY>`, resolves package by name with optional exact version; without version returns latest, includes optional signature fields)
- `POST /workers/register` (requires header `x-admin-key: <ADMIN_API_KEY>`, registers worker agent metadata)
- `POST /workers/:id/heartbeat` (requires header `x-admin-key: <ADMIN_API_KEY>`, updates worker runtime status and last execution telemetry such as `lastTaskId`, `lastTaskKind`, `lastExecutionStatus`, `lastExecutionError`)
- `GET /workers?limit=50&errorsOnly=true|false` (requires header `x-admin-key: <ADMIN_API_KEY>`, lists worker agents with optional error-state filtering)
- `GET /workers/:id` (requires header `x-admin-key: <ADMIN_API_KEY>`, returns worker snapshot)
- `GET /admin/audit?limit=50&nodeId=...&taskId=...&eventType=...&since=...&until=...` (requires header `x-admin-key: <ADMIN_API_KEY>`)
- `GET /admin/audit/export?format=jsonl|csv&limit=50&nodeId=...&taskId=...&eventType=...&since=...&until=...` (requires header `x-admin-key: <ADMIN_API_KEY>`)

Audit event types include: `task_created`, `task_claimed`, `task_canceled`, `task_deleted`, `task_requeued`, `node_disabled`, `node_enabled`, `node_quarantined`, `result_submitted`, `result_rejected`, `heartbeat_received`, `lease_expired`.

## Runtime Env Vars

Orchestrator:
- `PORT` (default `4000`)
- `LEASE_TTL_MS` (default `30000`)
- `MAX_TASK_ATTEMPTS` (default `4`)
- `ADMIN_API_KEY` (required for `/admin/*` endpoints)
- `ADMIN_RATE_LIMIT_MAX` (default `60` requests/window per IP)
- `ADMIN_RATE_LIMIT_WINDOW_MS` (default `60000`)
- `AUTO_QUARANTINE_MIN_REJECTED` (default `3`, auto-quarantines enabled nodes when rejected results exceed accepted results and hit this threshold)
- `AUTO_UNQUARANTINE_AFTER_MS` (default `300000`, auto-re-enables only auto-quarantined nodes after cooldown when a fresh heartbeat arrives)
- `AUDIT_LOG_PATH` (default `./data/audit-log.jsonl`)
- `AUDIT_LOG_MAX_BYTES` (default `5000000`)
- `AUDIT_LOG_MAX_FILES` (default `5`)
- `AUDIT_LOG_RETENTION_DAYS` (default `30`, rotated files older than this are removed)
- `STATE_SNAPSHOT_PATH` (default `./data/state-snapshot.json`, persists queue, nodes, workers, verdict history and package registry across orchestrator restarts)
- `PACKAGE_SIGNING_KEY` (optional, enables `hmac-sha256` package signatures in package registry responses)
- `TASK_SIGNING_KEY` (optional, enables `hmac-sha256` signatures on task envelopes)
- `TASK_SIGNATURE_TTL_MS` (default `3600000`, expiry window for signed task envelopes)

Edge runtime:
- `ORCHESTRATOR_URL` (default `http://localhost:4000`)
- `NODE_ID` (default random `node-xxxxxxxx`)
- `EDGE_ADMIN_API_KEY` (optional, used by worker to download registered packages from `/packages/:id`)
- `EDGE_PACKAGE_SIGNING_KEY` (optional, when set worker enforces package signature verification before execution)
- `EDGE_TASK_SIGNING_KEY` (optional, when set worker enforces signed task envelope verification before execution)
- `EDGE_PACKAGE_POLICY_MODE` (`strict` default, `relaxed` allows declared permissions without allowlist denial)
- `EDGE_ALLOWED_PACKAGE_PERMISSIONS` (comma-separated allowlist used in `strict` mode, e.g. `environment,network`)
- `EDGE_AGENT_MODE` (default `full`; available: `full`, `mobile_safe`, `package_worker`, `llm_central`)
- `EDGE_ALLOWED_TASK_KINDS` (optional comma-separated explicit task allowlist override, e.g. `package_execute,llm_inference`)
- `EDGE_LLM_ROLE` (optional, set to `central_host` on the main machine that serves full-model LLM inference)
- `EDGE_LLM_MODEL_VERSIONS` (comma-separated model versions advertised by the central LLM host, e.g. `bio-llm-v1,bio-llm-v2`)
- `EDGE_LLM_MAX_CONTEXT_TOKENS` (optional capability metadata for central LLM hosts)
- `EDGE_LLM_CONCURRENCY` (optional capability metadata for central LLM hosts)
- `EDGE_AGENT_VERSION` (optional, worker version string sent during `/workers/register`)
- `EDGE_PROFILE` (`mobile` default, `desktop-gpu` enables desktop GPU capability mode)
- `EDGE_GPU_VENDOR` (used when `EDGE_PROFILE=desktop-gpu`)
- `EDGE_GPU_MODEL` (used when `EDGE_PROFILE=desktop-gpu`)
- `EDGE_GPU_VRAM_GB` (used when `EDGE_PROFILE=desktop-gpu`, default `8`)

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

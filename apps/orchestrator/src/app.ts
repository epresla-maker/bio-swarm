import Fastify from "fastify";
import crypto from "node:crypto";
import type { NodeCapabilities, SwarmTask, TaskResult } from "@bio-swarm/shared";
import {
  addTask,
  cancelTask,
  claimTask,
  deleteTask,
  getAuditLog,
  getAdminDashboardSnapshot,
  getAuditPersistenceStatus,
  getNodeSnapshot,
  getNodeStatusSummary,
  getTaskVerdicts,
  getTaskStatusSummary,
  listTaskResults,
  listNodeSnapshots,
  listTaskSnapshots,
  getNodeStats,
  getRecentVerdicts,
  getTaskSnapshot,
  getTelemetrySnapshot,
  requeueTask,
  recordHeartbeat,
  submitResult,
  updateNodeControl
} from "./store.js";
import { renderAdminDashboardPage } from "./admin-dashboard-page.js";

interface AdminRateState {
  windowStartMs: number;
  count: number;
}

interface ResearchExperimentPayload {
  experimentId: string;
  name: string;
  modelVersion: string;
  steps: number;
  mutationRate: number;
  populationSize: number;
  prompt: string;
}

interface ResearchExperimentView {
  experimentId: string;
  taskId: string;
  name: string;
  modelVersion: string;
  steps: number;
  mutationRate: number;
  populationSize: number;
  prompt: string;
  status: "queued" | "running" | "completed" | "failed";
  createdAt: string;
  quorum: number;
  resultCount: number;
  bestScore: number | null;
}

export function buildApp(options?: {
  logger?: boolean;
  adminApiKey?: string;
  adminRateLimitMax?: number;
  adminRateLimitWindowMs?: number;
  nowProvider?: () => number;
}) {
  const app = Fastify({ logger: options?.logger ?? false });
  const adminApiKey = options?.adminApiKey ?? process.env.ADMIN_API_KEY ?? "";
  const adminRateLimitMax = options?.adminRateLimitMax ?? Number(process.env.ADMIN_RATE_LIMIT_MAX ?? 60);
  const adminRateLimitWindowMs =
    options?.adminRateLimitWindowMs ?? Number(process.env.ADMIN_RATE_LIMIT_WINDOW_MS ?? 60_000);
  const nowProvider = options?.nowProvider ?? (() => Date.now());
  const adminRateMap = new Map<string, AdminRateState>();
  const allowedAuditEventTypes = new Set([
    "task_created",
    "task_claimed",
    "task_canceled",
    "task_deleted",
    "task_requeued",
    "node_disabled",
    "node_enabled",
    "node_quarantined",
    "result_submitted",
    "result_rejected",
    "heartbeat_received",
    "lease_expired"
  ]);

  function enforceAdminAccess(request: { headers: Record<string, string | string[] | undefined>; ip: string }, reply: { status: (code: number) => { send: (payload: Record<string, string>) => unknown } }): boolean {
    if (!adminApiKey) {
      reply.status(503).send({ error: "admin_api_key_not_configured" });
      return false;
    }

    const providedKey = request.headers["x-admin-key"];
    if (providedKey !== adminApiKey) {
      reply.status(401).send({ error: "unauthorized" });
      return false;
    }

    const forwarded = request.headers["x-forwarded-for"];
    const forwardedValue = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const clientIp = forwardedValue ?? request.ip;
    const now = nowProvider();
    const existing = adminRateMap.get(clientIp);
    if (!existing || now - existing.windowStartMs >= adminRateLimitWindowMs) {
      adminRateMap.set(clientIp, { windowStartMs: now, count: 1 });
      return true;
    }

    if (existing.count >= adminRateLimitMax) {
      reply.status(429).send({ error: "admin_rate_limited" });
      return false;
    }

    existing.count += 1;
    return true;
  }

  function parseAuditQuery(
    request: {
      query: {
        limit?: string;
        nodeId?: string;
        taskId?: string;
        eventType?: string;
        since?: string;
        until?: string;
      };
    },
    reply: { status: (code: number) => { send: (payload: Record<string, string>) => unknown } }
  ) {
    const rawLimit = request.query.limit;
    const parsedLimit = rawLimit ? Number(rawLimit) : 50;
    if (!Number.isFinite(parsedLimit) || parsedLimit < 1) {
      reply.status(400).send({ error: "invalid_limit" });
      return;
    }

    const eventType = request.query.eventType;
    if (eventType && !allowedAuditEventTypes.has(eventType)) {
      reply.status(400).send({ error: "invalid_event_type" });
      return;
    }

    const since = request.query.since ? Date.parse(request.query.since) : undefined;
    const until = request.query.until ? Date.parse(request.query.until) : undefined;

    if (typeof since === "number" && Number.isNaN(since)) {
      reply.status(400).send({ error: "invalid_since" });
      return;
    }

    if (typeof until === "number" && Number.isNaN(until)) {
      reply.status(400).send({ error: "invalid_until" });
      return;
    }

    return {
      limit: parsedLimit,
      nodeId: request.query.nodeId,
      taskId: request.query.taskId,
      eventType: eventType as
        | "task_created"
        | "task_claimed"
        | "task_canceled"
        | "task_deleted"
        | "task_requeued"
        | "node_disabled"
        | "node_enabled"
        | "node_quarantined"
        | "result_submitted"
        | "result_rejected"
        | "heartbeat_received"
        | "lease_expired"
        | undefined,
      since,
      until
    };
  }

  function getResearchExperimentPayload(task: SwarmTask): ResearchExperimentPayload | null {
    if (task.kind !== "bio_simulation") {
      return null;
    }

    const payload = task.payload;
    const experimentId = payload.experimentId;
    const name = payload.name;
    const modelVersion = payload.modelVersion;
    const steps = payload.steps;
    const mutationRate = payload.mutationRate;
    const populationSize = payload.populationSize;
    const prompt = payload.prompt;

    if (
      typeof experimentId !== "string" ||
      typeof name !== "string" ||
      typeof modelVersion !== "string" ||
      typeof steps !== "number" ||
      typeof mutationRate !== "number" ||
      typeof populationSize !== "number" ||
      typeof prompt !== "string"
    ) {
      return null;
    }

    return {
      experimentId,
      name,
      modelVersion,
      steps,
      mutationRate,
      populationSize,
      prompt
    };
  }

  function mapTaskStateToExperimentStatus(state: "pending" | "leased" | "completed" | "failed") {
    if (state === "pending") {
      return "queued" as const;
    }

    if (state === "leased") {
      return "running" as const;
    }

    return state;
  }

  function getResearchExperimentViews(limit: number): ResearchExperimentView[] {
    const snapshots = listTaskSnapshots({ limit: 500, state: undefined });
    const views: ResearchExperimentView[] = [];

    for (const snapshot of snapshots) {
      const payload = getResearchExperimentPayload(snapshot.task);
      if (!payload) {
        continue;
      }

      const results = listTaskResults({ taskId: snapshot.task.id, limit: 200 });
      const bestScore =
        results.items.length > 0
          ? results.items.reduce((max, item) => (item.score > max ? item.score : max), Number.NEGATIVE_INFINITY)
          : null;

      views.push({
        experimentId: payload.experimentId,
        taskId: snapshot.task.id,
        name: payload.name,
        modelVersion: payload.modelVersion,
        steps: payload.steps,
        mutationRate: payload.mutationRate,
        populationSize: payload.populationSize,
        prompt: payload.prompt,
        status: mapTaskStateToExperimentStatus(snapshot.state),
        createdAt: snapshot.task.createdAt,
        quorum: snapshot.task.quorum,
        resultCount: snapshot.resultCount,
        bestScore
      });
    }

    return views.slice(0, limit);
  }

  app.get("/health", async () => {
    return { ok: true };
  });

  app.post<{ Body: Pick<SwarmTask, "kind" | "payload" | "quorum"> }>("/tasks", async (request, reply) => {
    if (!enforceAdminAccess(request, reply)) {
      return;
    }

    const { kind, payload, quorum } = request.body;

    if (!kind || typeof quorum !== "number" || quorum < 1) {
      return reply.status(400).send({ error: "invalid_task_payload" });
    }

    const task = addTask({ kind, payload: payload ?? {}, quorum });
    return reply.status(201).send(task);
  });

  app.post<{
    Body: {
      name?: string;
      modelVersion?: string;
      steps?: number;
      quorum?: number;
      mutationRate?: number;
      populationSize?: number;
      prompt?: string;
    };
  }>("/research/experiments", async (request, reply) => {
    if (!enforceAdminAccess(request, reply)) {
      return;
    }

    const name = request.body.name?.trim();
    const modelVersion = request.body.modelVersion?.trim();
    const prompt = request.body.prompt?.trim();
    const steps = request.body.steps;
    const quorum = request.body.quorum;
    const mutationRate = request.body.mutationRate ?? 0.015;
    const populationSize = request.body.populationSize ?? 512;

    if (!name || !modelVersion || !prompt) {
      return reply.status(400).send({ error: "invalid_experiment_payload" });
    }

    if (typeof steps !== "number" || !Number.isFinite(steps) || steps < 10) {
      return reply.status(400).send({ error: "invalid_steps" });
    }

    if (typeof quorum !== "number" || !Number.isFinite(quorum) || quorum < 1) {
      return reply.status(400).send({ error: "invalid_quorum" });
    }

    if (typeof mutationRate !== "number" || !Number.isFinite(mutationRate) || mutationRate <= 0 || mutationRate > 1) {
      return reply.status(400).send({ error: "invalid_mutation_rate" });
    }

    if (
      typeof populationSize !== "number" ||
      !Number.isFinite(populationSize) ||
      populationSize < 32 ||
      populationSize > 1_000_000
    ) {
      return reply.status(400).send({ error: "invalid_population_size" });
    }

    const experimentId = crypto.randomUUID();
    const task = addTask({
      kind: "bio_simulation",
      quorum,
      payload: {
        experimentId,
        name,
        modelVersion,
        steps: Math.floor(steps),
        mutationRate,
        populationSize: Math.floor(populationSize),
        prompt
      }
    });

    return reply.status(201).send({
      experimentId,
      taskId: task.id,
      status: "queued"
    });
  });

  app.get<{ Querystring: { limit?: string } }>("/research/experiments", async (request, reply) => {
    if (!enforceAdminAccess(request, reply)) {
      return;
    }

    const parsedLimit = request.query.limit ? Number(request.query.limit) : 25;
    if (!Number.isFinite(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
      return reply.status(400).send({ error: "invalid_limit" });
    }

    return reply.status(200).send({ items: getResearchExperimentViews(Math.floor(parsedLimit)) });
  });

  app.get<{ Params: { id: string } }>("/research/experiments/:id", async (request, reply) => {
    if (!enforceAdminAccess(request, reply)) {
      return;
    }

    const view = getResearchExperimentViews(500).find((item) => item.experimentId === request.params.id);
    if (!view) {
      return reply.status(404).send({ error: "experiment_not_found" });
    }

    const results = listTaskResults({ taskId: view.taskId, limit: 200 });
    return reply.status(200).send({
      ...view,
      results: results.items
    });
  });

  app.get<{ Querystring: { state?: string; limit?: string } }>("/tasks", async (request, reply) => {
    const rawLimit = request.query.limit;
    const parsedLimit = rawLimit ? Number(rawLimit) : 20;
    if (!Number.isFinite(parsedLimit) || parsedLimit < 1) {
      return reply.status(400).send({ error: "invalid_limit" });
    }

    const rawState = request.query.state;
    const allowedStates = new Set(["pending", "leased", "completed", "failed"]);
    if (rawState && !allowedStates.has(rawState)) {
      return reply.status(400).send({ error: "invalid_state" });
    }

    const items = listTaskSnapshots({
      limit: parsedLimit,
      state: rawState as "pending" | "leased" | "completed" | "failed" | undefined
    });
    return reply.status(200).send({ items });
  });

  app.get<{ Querystring: { nodeId?: string } }>("/tasks/claim", async (request, reply) => {
    const nodeId = request.query.nodeId;
    if (!nodeId) {
      return reply.status(400).send({ error: "missing_node_id" });
    }

    const task = claimTask(nodeId);
    if (!task) {
      return reply.status(204).send();
    }

    return reply.status(200).send(task);
  });

  app.get<{ Params: { id: string } }>("/tasks/:id", async (request, reply) => {
    const snapshot = getTaskSnapshot(request.params.id);
    if (!snapshot) {
      return reply.status(404).send({ error: "task_not_found" });
    }

    return reply.status(200).send(snapshot);
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>("/tasks/:id/results", async (request, reply) => {
    const rawLimit = request.query.limit;
    const parsedLimit = rawLimit ? Number(rawLimit) : 50;
    if (!Number.isFinite(parsedLimit) || parsedLimit < 1) {
      return reply.status(400).send({ error: "invalid_limit" });
    }

    const result = listTaskResults({ taskId: request.params.id, limit: parsedLimit });
    if (!result.found) {
      return reply.status(404).send({ error: "task_not_found" });
    }

    return reply.status(200).send({ items: result.items });
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>("/tasks/:id/verdicts", async (request, reply) => {
    const rawLimit = request.query.limit;
    const parsedLimit = rawLimit ? Number(rawLimit) : 50;
    if (!Number.isFinite(parsedLimit) || parsedLimit < 1) {
      return reply.status(400).send({ error: "invalid_limit" });
    }

    const verdicts = getTaskVerdicts({ taskId: request.params.id, limit: parsedLimit });
    if (!verdicts.found) {
      return reply.status(404).send({ error: "task_not_found" });
    }

    return reply.status(200).send({ items: verdicts.items });
  });

  app.get<{
    Params: { id: string };
    Querystring: { limit?: string; eventType?: string; since?: string; until?: string };
  }>("/tasks/:id/audit", async (request, reply) => {
    if (!enforceAdminAccess(request, reply)) {
      return;
    }

    const snapshot = getTaskSnapshot(request.params.id);
    if (!snapshot) {
      return reply.status(404).send({ error: "task_not_found" });
    }

    const query = parseAuditQuery(
      {
        query: {
          limit: request.query.limit,
          taskId: request.params.id,
          eventType: request.query.eventType,
          since: request.query.since,
          until: request.query.until
        }
      },
      reply
    );
    if (!query) {
      return;
    }

    return reply.status(200).send({ items: getAuditLog(query) });
  });

  app.post<{ Params: { id: string }; Body: Omit<TaskResult, "taskId" | "submittedAt"> }>(
    "/tasks/:id/result",
    async (request, reply) => {
      const taskId = request.params.id;
      const { nodeId, checksum, score, payload } = request.body;

      if (!nodeId || !checksum || typeof score !== "number") {
        return reply.status(400).send({ error: "invalid_result_payload" });
      }

      const result: TaskResult = {
        taskId,
        nodeId,
        checksum,
        score,
        payload: payload ?? {},
        submittedAt: new Date().toISOString()
      };

      const verdict = submitResult(result);
      if (!verdict.accepted) {
        return reply.status(409).send(verdict);
      }

      return reply.status(202).send(verdict);
    }
  );

  app.post<{ Params: { id: string } }>("/tasks/:id/cancel", async (request, reply) => {
    if (!enforceAdminAccess(request, reply)) {
      return;
    }

    const verdict = cancelTask(request.params.id);

    if (!verdict.canceled && verdict.reason === "task_not_found") {
      return reply.status(404).send(verdict);
    }

    if (!verdict.canceled && verdict.reason === "task_already_completed") {
      return reply.status(409).send(verdict);
    }

    return reply.status(200).send(verdict);
  });

  app.post<{ Params: { id: string } }>("/tasks/:id/requeue", async (request, reply) => {
    if (!enforceAdminAccess(request, reply)) {
      return;
    }

    const verdict = requeueTask(request.params.id);

    if (!verdict.requeued && verdict.reason === "task_not_found") {
      return reply.status(404).send(verdict);
    }

    if (!verdict.requeued) {
      return reply.status(409).send(verdict);
    }

    return reply.status(200).send(verdict);
  });

  app.delete<{ Params: { id: string } }>("/tasks/:id", async (request, reply) => {
    if (!enforceAdminAccess(request, reply)) {
      return;
    }

    const verdict = deleteTask(request.params.id);
    if (!verdict.deleted) {
      return reply.status(404).send(verdict);
    }

    return reply.status(200).send(verdict);
  });

  app.get<{ Querystring: { active?: string; limit?: string } }>("/nodes", async (request, reply) => {
    const rawLimit = request.query.limit;
    const parsedLimit = rawLimit ? Number(rawLimit) : 50;
    if (!Number.isFinite(parsedLimit) || parsedLimit < 1) {
      return reply.status(400).send({ error: "invalid_limit" });
    }

    const rawActive = request.query.active;
    let activeOnly = false;
    if (typeof rawActive === "string") {
      if (rawActive === "true") {
        activeOnly = true;
      } else if (rawActive === "false") {
        activeOnly = false;
      } else {
        return reply.status(400).send({ error: "invalid_active_filter" });
      }
    }

    const items = listNodeSnapshots({ limit: parsedLimit, activeOnly });
    return reply.status(200).send({ items });
  });

  app.get<{ Params: { id: string } }>("/nodes/:id", async (request, reply) => {
    const snapshot = getNodeSnapshot(request.params.id);
    if (!snapshot) {
      return reply.status(404).send({ error: "node_not_found" });
    }

    return reply.status(200).send(snapshot);
  });

  app.post<{ Params: { id: string }; Body: { reason?: string } }>("/nodes/:id/disable", async (request, reply) => {
    if (!enforceAdminAccess(request, reply)) {
      return;
    }

    const verdict = updateNodeControl(request.params.id, "disabled", request.body?.reason);
    if (!verdict.found) {
      return reply.status(404).send({ error: "node_not_found" });
    }

    return reply.status(200).send({ ok: true, control: verdict.control });
  });

  app.post<{ Params: { id: string }; Body: { reason?: string } }>("/nodes/:id/quarantine", async (request, reply) => {
    if (!enforceAdminAccess(request, reply)) {
      return;
    }

    const verdict = updateNodeControl(request.params.id, "quarantined", request.body?.reason);
    if (!verdict.found) {
      return reply.status(404).send({ error: "node_not_found" });
    }

    return reply.status(200).send({ ok: true, control: verdict.control });
  });

  app.post<{ Params: { id: string } }>("/nodes/:id/enable", async (request, reply) => {
    if (!enforceAdminAccess(request, reply)) {
      return;
    }

    const verdict = updateNodeControl(request.params.id, "enabled");
    if (!verdict.found) {
      return reply.status(404).send({ error: "node_not_found" });
    }

    return reply.status(200).send({ ok: true, control: verdict.control });
  });

  app.get<{
    Params: { id: string };
    Querystring: { limit?: string; eventType?: string; since?: string; until?: string };
  }>("/nodes/:id/audit", async (request, reply) => {
    if (!enforceAdminAccess(request, reply)) {
      return;
    }

    const snapshot = getNodeSnapshot(request.params.id);
    if (!snapshot) {
      return reply.status(404).send({ error: "node_not_found" });
    }

    const query = parseAuditQuery(
      {
        query: {
          limit: request.query.limit,
          nodeId: request.params.id,
          eventType: request.query.eventType,
          since: request.query.since,
          until: request.query.until
        }
      },
      reply
    );
    if (!query) {
      return;
    }

    return reply.status(200).send({ items: getAuditLog(query) });
  });

  app.get<{ Params: { id: string } }>("/nodes/:id/stats", async (request) => {
    return getNodeStats(request.params.id);
  });

  app.post<{ Params: { id: string }; Body: { capabilities?: NodeCapabilities } }>(
    "/nodes/:id/heartbeat",
    async (request, reply) => {
      const nodeId = request.params.id;
      const capabilities = request.body?.capabilities;

      if (capabilities) {
        const values = [capabilities.charging, capabilities.wifi, capabilities.idle, capabilities.userOptIn];
        const valid = values.every((value) => typeof value === "boolean");
        if (!valid) {
          return reply.status(400).send({ error: "invalid_capabilities" });
        }
      }

      const stats = recordHeartbeat(nodeId, capabilities);
      return reply.status(200).send({ ok: true, stats });
    }
  );

  app.get("/telemetry", async () => {
    return getTelemetrySnapshot();
  });

  app.get<{ Querystring: { limit?: string; taskId?: string; accepted?: string } }>("/admin/verdicts", async (request, reply) => {
    if (!enforceAdminAccess(request, reply)) {
      return;
    }

    const rawLimit = request.query.limit;
    const rawTaskId = request.query.taskId;
    const rawAccepted = request.query.accepted;
    const parsed = rawLimit ? Number(rawLimit) : 20;

    if (!Number.isFinite(parsed) || parsed < 1) {
      return reply.status(400).send({ error: "invalid_limit" });
    }

    let acceptedFilter: boolean | undefined;
    if (typeof rawAccepted === "string") {
      if (rawAccepted === "true") {
        acceptedFilter = true;
      } else if (rawAccepted === "false") {
        acceptedFilter = false;
      } else {
        return reply.status(400).send({ error: "invalid_accepted_filter" });
      }
    }

    return {
      items: getRecentVerdicts({
        limit: parsed,
        taskId: rawTaskId,
        accepted: acceptedFilter
      })
    };
  });

  app.get("/admin/status", async (request, reply) => {
    if (!enforceAdminAccess(request, reply)) {
      return;
    }

    return {
      tasks: getTaskStatusSummary(),
      nodes: getNodeStatusSummary(),
      recentVerdicts: getRecentVerdicts({ limit: 5 }),
      recentAudit: getAuditLog({ limit: 5 }),
      auditPersistence: getAuditPersistenceStatus()
    };
  });

  app.get("/admin/dashboard", async (request, reply) => {
    if (!enforceAdminAccess(request, reply)) {
      return;
    }

    return getAdminDashboardSnapshot();
  });

  app.get("/admin/dashboard/ui", async (_request, reply) => {
    reply.header("content-type", "text/html; charset=utf-8");
    return reply.send(renderAdminDashboardPage());
  });

  app.get<{ Querystring: { limit?: string; nodeId?: string; taskId?: string; eventType?: string; since?: string; until?: string } }>(
    "/admin/audit",
    async (request, reply) => {
      if (!enforceAdminAccess(request, reply)) {
        return;
      }

      const query = parseAuditQuery(request, reply);
      if (!query) {
        return;
      }

      return { items: getAuditLog(query) };
    }
  );

  app.get<{
    Querystring: {
      format?: string;
      limit?: string;
      nodeId?: string;
      taskId?: string;
      eventType?: string;
      since?: string;
      until?: string;
    };
  }>("/admin/audit/export", async (request, reply) => {
    if (!enforceAdminAccess(request, reply)) {
      return;
    }

    const format = request.query.format ?? "jsonl";
    if (format !== "jsonl" && format !== "csv") {
      return reply.status(400).send({ error: "invalid_format" });
    }

    const query = parseAuditQuery(request, reply);
    if (!query) {
      return;
    }

    const items = getAuditLog(query);

    if (format === "jsonl") {
      const body = items.map((item) => JSON.stringify(item)).join("\n");
      reply.header("content-type", "application/x-ndjson; charset=utf-8");
      return reply.send(body);
    }

    const csvEscape = (value: string): string => {
      if (value.includes(",") || value.includes("\"") || value.includes("\n")) {
        return `"${value.replace(/\"/g, '""')}"`;
      }
      return value;
    };

    const header = "at,eventType,taskId,nodeId,details";
    const rows = items.map((item) => {
      const details = item.details ? JSON.stringify(item.details) : "";
      return [
        csvEscape(item.at),
        csvEscape(item.eventType),
        csvEscape(item.taskId ?? ""),
        csvEscape(item.nodeId ?? ""),
        csvEscape(details)
      ].join(",");
    });

    reply.header("content-type", "text/csv; charset=utf-8");
    return reply.send([header, ...rows].join("\n"));
  });

  return app;
}
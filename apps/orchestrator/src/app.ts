import Fastify from "fastify";
import type { NodeCapabilities, SwarmTask, TaskResult } from "@bio-swarm/shared";
import { addTask, claimTask, getAuditLog, getNodeStats, getRecentVerdicts, getTelemetrySnapshot, recordHeartbeat, submitResult } from "./store.js";

interface AdminRateState {
  windowStartMs: number;
  count: number;
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
        | "result_submitted"
        | "result_rejected"
        | "heartbeat_received"
        | "lease_expired"
        | undefined,
      since,
      until
    };
  }

  app.get("/health", async () => {
    return { ok: true };
  });

  app.post<{ Body: Pick<SwarmTask, "kind" | "payload" | "quorum"> }>("/tasks", async (request, reply) => {
    const { kind, payload, quorum } = request.body;

    if (!kind || typeof quorum !== "number" || quorum < 1) {
      return reply.status(400).send({ error: "invalid_task_payload" });
    }

    const task = addTask({ kind, payload: payload ?? {}, quorum });
    return reply.status(201).send(task);
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
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

      const rawLimit = request.query.limit;
      const parsedLimit = rawLimit ? Number(rawLimit) : 50;
      if (!Number.isFinite(parsedLimit) || parsedLimit < 1) {
        return reply.status(400).send({ error: "invalid_limit" });
      }

      const eventType = request.query.eventType;
      const allowedEventTypes = new Set([
        "task_created",
        "task_claimed",
        "result_submitted",
        "result_rejected",
        "heartbeat_received",
        "lease_expired"
      ]);
      if (eventType && !allowedEventTypes.has(eventType)) {
        return reply.status(400).send({ error: "invalid_event_type" });
      }

      const since = request.query.since ? Date.parse(request.query.since) : undefined;
      const until = request.query.until ? Date.parse(request.query.until) : undefined;

      if (typeof since === "number" && Number.isNaN(since)) {
        return reply.status(400).send({ error: "invalid_since" });
      }

      if (typeof until === "number" && Number.isNaN(until)) {
        return reply.status(400).send({ error: "invalid_until" });
      }

      return {
        items: getAuditLog({
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
        })
      };
    }
  );

  return app;
}
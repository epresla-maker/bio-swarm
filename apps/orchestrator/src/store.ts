import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { NodeCapabilities, NodeStats, SwarmTask, TaskResult, TelemetrySnapshot } from "@bio-swarm/shared";

interface TaskRecord {
  task: SwarmTask;
  results: TaskResult[];
  completed: boolean;
  failed: boolean;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  attempts: number;
}

export interface TaskVerdictLogEntry {
  taskId: string;
  nodeId: string;
  accepted: boolean;
  reason: string | null;
  at: string;
}

export interface VerdictQuery {
  limit: number;
  taskId?: string;
  accepted?: boolean;
}

export type AuditEventType =
  | "task_created"
  | "task_claimed"
  | "result_submitted"
  | "result_rejected"
  | "heartbeat_received"
  | "lease_expired";

export interface AuditLogEntry {
  at: string;
  eventType: AuditEventType;
  taskId?: string;
  nodeId?: string;
  details?: Record<string, unknown>;
}

export interface AuditQuery {
  limit: number;
  nodeId?: string;
  taskId?: string;
  eventType?: AuditEventType;
  since?: number;
  until?: number;
}

const tasks = new Map<string, TaskRecord>();
const nodeStats = new Map<string, NodeStats>();
const nodeCapabilities = new Map<string, NodeCapabilities>();

let leaseTtlMs = Number(process.env.LEASE_TTL_MS ?? 30_000);
let maxAttempts = Number(process.env.MAX_TASK_ATTEMPTS ?? 4);
let nowProvider: () => number = () => Date.now();

let retryCount = 0;
let expiredLeaseCount = 0;
const taskVerdicts: TaskVerdictLogEntry[] = [];
const MAX_VERDICT_LOG = 200;
const auditLog: AuditLogEntry[] = [];
const MAX_AUDIT_LOG = 500;
let auditLogPath: string | null = null;

export function configureStoreRuntime(options: {
  leaseTtlMs?: number;
  maxAttempts?: number;
  nowProvider?: () => number;
}): void {
  if (typeof options.leaseTtlMs === "number" && Number.isFinite(options.leaseTtlMs) && options.leaseTtlMs > 0) {
    leaseTtlMs = options.leaseTtlMs;
  }

  if (typeof options.maxAttempts === "number" && Number.isFinite(options.maxAttempts) && options.maxAttempts > 0) {
    maxAttempts = options.maxAttempts;
  }

  if (options.nowProvider) {
    nowProvider = options.nowProvider;
  }
}

export function resetStoreForTests(): void {
  tasks.clear();
  nodeStats.clear();
  nodeCapabilities.clear();
  retryCount = 0;
  expiredLeaseCount = 0;
  taskVerdicts.length = 0;
  auditLog.length = 0;
  auditLogPath = null;
  leaseTtlMs = Number(process.env.LEASE_TTL_MS ?? 30_000);
  maxAttempts = Number(process.env.MAX_TASK_ATTEMPTS ?? 4);
  nowProvider = () => Date.now();
}

export function configureAuditLogPersistence(filePath?: string): void {
  if (!filePath) {
    auditLogPath = null;
    return;
  }

  auditLogPath = filePath;
  ensureAuditLogLoadedFromDisk(filePath);
}

export function addTask(input: Omit<SwarmTask, "id" | "createdAt">): SwarmTask {
  const task: SwarmTask = {
    id: crypto.randomUUID(),
    createdAt: new Date(nowProvider()).toISOString(),
    kind: input.kind,
    payload: input.payload,
    quorum: input.quorum
  };

  tasks.set(task.id, {
    task,
    results: [],
    completed: false,
    failed: false,
    leaseOwner: null,
    leaseExpiresAt: null,
    attempts: 0
  });

  pushAuditEvent({
    eventType: "task_created",
    taskId: task.id,
    details: { kind: task.kind, quorum: task.quorum }
  });

  return task;
}

export function claimTask(nodeId: string): SwarmTask | null {
  sweepExpiredLeases();

  for (const record of tasks.values()) {
    if (record.completed || record.failed) {
      continue;
    }

    if (record.leaseOwner) {
      continue;
    }

    if (record.results.length >= record.task.quorum) {
      continue;
    }

    if (record.results.some((item) => item.nodeId === nodeId)) {
      continue;
    }

    if (record.attempts >= maxAttempts) {
      record.failed = true;
      continue;
    }

    record.attempts += 1;
    if (record.attempts > 1) {
      retryCount += 1;
    }
    record.leaseOwner = nodeId;
    record.leaseExpiresAt = nowProvider() + leaseTtlMs;
    touchNode(nodeId);
    pushAuditEvent({
      eventType: "task_claimed",
      taskId: record.task.id,
      nodeId,
      details: { attempts: record.attempts }
    });
    return record.task;
  }

  return null;
}

export function submitResult(result: TaskResult): { accepted: boolean; reason?: string } {
  sweepExpiredLeases();

  const record = tasks.get(result.taskId);
  if (!record) {
    incrementNode(result.nodeId, false);
    pushVerdict(result.taskId, result.nodeId, false, "task_not_found");
    pushAuditEvent({
      eventType: "result_rejected",
      taskId: result.taskId,
      nodeId: result.nodeId,
      details: { reason: "task_not_found" }
    });
    return { accepted: false, reason: "task_not_found" };
  }

  if (record.completed || record.failed) {
    incrementNode(result.nodeId, false);
    pushVerdict(result.taskId, result.nodeId, false, "task_already_completed");
    pushAuditEvent({
      eventType: "result_rejected",
      taskId: result.taskId,
      nodeId: result.nodeId,
      details: { reason: "task_already_completed" }
    });
    return { accepted: false, reason: "task_already_completed" };
  }

  if (record.leaseOwner !== result.nodeId) {
    incrementNode(result.nodeId, false);
    pushVerdict(result.taskId, result.nodeId, false, "node_does_not_hold_lease");
    pushAuditEvent({
      eventType: "result_rejected",
      taskId: result.taskId,
      nodeId: result.nodeId,
      details: { reason: "node_does_not_hold_lease" }
    });
    return { accepted: false, reason: "node_does_not_hold_lease" };
  }

  if (record.leaseExpiresAt !== null && nowProvider() > record.leaseExpiresAt) {
    clearLease(record);
    incrementNode(result.nodeId, false);
    pushVerdict(result.taskId, result.nodeId, false, "lease_expired");
    pushAuditEvent({
      eventType: "result_rejected",
      taskId: result.taskId,
      nodeId: result.nodeId,
      details: { reason: "lease_expired" }
    });
    return { accepted: false, reason: "lease_expired" };
  }

  const duplicate = record.results.some((item) => item.nodeId === result.nodeId);
  if (duplicate) {
    incrementNode(result.nodeId, false);
    pushVerdict(result.taskId, result.nodeId, false, "duplicate_node_submission");
    pushAuditEvent({
      eventType: "result_rejected",
      taskId: result.taskId,
      nodeId: result.nodeId,
      details: { reason: "duplicate_node_submission" }
    });
    return { accepted: false, reason: "duplicate_node_submission" };
  }

  record.results.push(result);
  clearLease(record);
  incrementNode(result.nodeId, true);

  // MVP quorum check: task is complete once enough independent node results arrive.
  if (record.results.length >= record.task.quorum) {
    record.completed = true;
  }

  pushVerdict(result.taskId, result.nodeId, true, null);
  pushAuditEvent({
    eventType: "result_submitted",
    taskId: result.taskId,
    nodeId: result.nodeId,
    details: { score: result.score }
  });

  return { accepted: true };
}

export function getRecentVerdicts(query: VerdictQuery): TaskVerdictLogEntry[] {
  const bounded = Math.max(1, Math.min(100, Math.floor(query.limit)));
  const filtered = taskVerdicts.filter((item) => {
    if (query.taskId && item.taskId !== query.taskId) {
      return false;
    }

    if (typeof query.accepted === "boolean" && item.accepted !== query.accepted) {
      return false;
    }

    return true;
  });

  return filtered.slice(-bounded).reverse();
}

export function getAuditLog(query: AuditQuery): AuditLogEntry[] {
  const bounded = Math.max(1, Math.min(200, Math.floor(query.limit)));
  const filtered = auditLog.filter((item) => {
    if (query.nodeId && item.nodeId !== query.nodeId) {
      return false;
    }

    if (query.taskId && item.taskId !== query.taskId) {
      return false;
    }

    if (query.eventType && item.eventType !== query.eventType) {
      return false;
    }

    const time = new Date(item.at).getTime();
    if (typeof query.since === "number" && time < query.since) {
      return false;
    }

    if (typeof query.until === "number" && time > query.until) {
      return false;
    }

    return true;
  });

  return filtered.slice(-bounded).reverse();
}

export function recordHeartbeat(nodeId: string, capabilities?: NodeCapabilities): NodeStats {
  if (capabilities) {
    nodeCapabilities.set(nodeId, capabilities);
  }

  const stats = getNodeStats(nodeId);
  stats.heartbeats += 1;
  stats.lastSeenAt = new Date(nowProvider()).toISOString();
  pushAuditEvent({
    eventType: "heartbeat_received",
    nodeId,
    details: capabilities ? { capabilities } : undefined
  });
  return stats;
}

export function getTelemetrySnapshot(): TelemetrySnapshot {
  sweepExpiredLeases();

  let pending = 0;
  let leased = 0;
  let completed = 0;
  let failed = 0;

  for (const record of tasks.values()) {
    if (record.completed) {
      completed += 1;
      continue;
    }

    if (record.failed) {
      failed += 1;
      continue;
    }

    if (record.leaseOwner) {
      leased += 1;
    } else {
      pending += 1;
    }
  }

  const now = nowProvider();
  const activeNodesLast60s = Array.from(nodeStats.values()).filter((stats) => {
    if (!stats.lastSeenAt) {
      return false;
    }
    return now - new Date(stats.lastSeenAt).getTime() <= 60_000;
  }).length;

  return {
    generatedAt: new Date(nowProvider()).toISOString(),
    queue: {
      total: tasks.size,
      pending,
      leased,
      completed,
      failed,
      retries: retryCount,
      expiredLeases: expiredLeaseCount
    },
    activeNodesLast60s,
    totalNodes: nodeStats.size
  };
}

export function getNodeStats(nodeId: string): NodeStats {
  if (!nodeStats.has(nodeId)) {
    nodeStats.set(nodeId, {
      nodeId,
      accepted: 0,
      rejected: 0,
      heartbeats: 0,
      lastSeenAt: null
    });
  }

  return nodeStats.get(nodeId)!;
}

function touchNode(nodeId: string): void {
  const stats = getNodeStats(nodeId);
  stats.lastSeenAt = new Date(nowProvider()).toISOString();
}

function clearLease(record: TaskRecord): void {
  record.leaseOwner = null;
  record.leaseExpiresAt = null;
}

function sweepExpiredLeases(): void {
  const now = nowProvider();

  for (const record of tasks.values()) {
    if (record.completed || record.failed || !record.leaseOwner || record.leaseExpiresAt === null) {
      continue;
    }

    if (record.leaseExpiresAt > now) {
      continue;
    }

    expiredLeaseCount += 1;
    pushAuditEvent({
      eventType: "lease_expired",
      taskId: record.task.id,
      nodeId: record.leaseOwner,
      details: { attempts: record.attempts }
    });
    clearLease(record);

    if (record.attempts >= maxAttempts && record.results.length < record.task.quorum) {
      record.failed = true;
    }
  }
}

function incrementNode(nodeId: string, accepted: boolean): void {
  const stats = getNodeStats(nodeId);
  if (accepted) {
    stats.accepted += 1;
  } else {
    stats.rejected += 1;
  }
  stats.lastSeenAt = new Date(nowProvider()).toISOString();
}

function pushVerdict(taskId: string, nodeId: string, accepted: boolean, reason: string | null): void {
  taskVerdicts.push({
    taskId,
    nodeId,
    accepted,
    reason,
    at: new Date(nowProvider()).toISOString()
  });

  if (taskVerdicts.length > MAX_VERDICT_LOG) {
    taskVerdicts.splice(0, taskVerdicts.length - MAX_VERDICT_LOG);
  }
}

function pushAuditEvent(event: Omit<AuditLogEntry, "at">): void {
  const entry: AuditLogEntry = {
    ...event,
    at: new Date(nowProvider()).toISOString()
  };

  auditLog.push(entry);

  if (auditLog.length > MAX_AUDIT_LOG) {
    auditLog.splice(0, auditLog.length - MAX_AUDIT_LOG);
  }

  if (!auditLogPath) {
    return;
  }

  try {
    fs.mkdirSync(path.dirname(auditLogPath), { recursive: true });
    fs.appendFileSync(auditLogPath, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // Persistence failures should not break API behavior in MVP mode.
  }
}

function ensureAuditLogLoadedFromDisk(filePath: string): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, "", "utf8");
      return;
    }

    const text = fs.readFileSync(filePath, "utf8");
    const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);

    auditLog.length = 0;
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as AuditLogEntry;
        if (!parsed || typeof parsed.at !== "string" || typeof parsed.eventType !== "string") {
          continue;
        }
        auditLog.push(parsed);
      } catch {
        continue;
      }
    }

    if (auditLog.length > MAX_AUDIT_LOG) {
      auditLog.splice(0, auditLog.length - MAX_AUDIT_LOG);
    }
  } catch {
    // Ignore persistence bootstrap failures in MVP mode.
  }
}

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

export interface TaskSnapshot {
  task: SwarmTask;
  state: "pending" | "leased" | "completed" | "failed";
  attempts: number;
  resultCount: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
}

export interface TaskListQuery {
  limit: number;
  state?: TaskSnapshot["state"];
}

export interface TaskResultsQuery {
  taskId: string;
  limit: number;
}

export interface NodeListQuery {
  limit: number;
  activeOnly?: boolean;
}

export interface NodeSnapshot {
  stats: NodeStats;
  capabilities: NodeCapabilities | null;
  active: boolean;
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

export interface TaskVerdictsQuery {
  taskId: string;
  limit: number;
}

export type AuditEventType =
  | "task_created"
  | "task_claimed"
  | "task_canceled"
  | "task_deleted"
  | "task_requeued"
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

export interface AuditPersistenceStatus {
  enabled: boolean;
  path: string | null;
  maxBytes: number;
  maxFiles: number;
  retentionDays: number;
  fileExists: boolean;
  fileSizeBytes: number;
  rotatedFileCount: number;
  lastLoadedAt: string | null;
  lastWrittenAt: string | null;
  lastError: string | null;
}

export interface TaskStatusSummary {
  total: number;
  pending: number;
  leased: number;
  completed: number;
  failed: number;
}

export interface NodeStatusSummary {
  total: number;
  active: number;
  inactive: number;
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
let auditLogMaxBytes = Number(process.env.AUDIT_LOG_MAX_BYTES ?? 5_000_000);
let auditLogMaxFiles = Number(process.env.AUDIT_LOG_MAX_FILES ?? 5);
let auditLogRetentionDays = Number(process.env.AUDIT_LOG_RETENTION_DAYS ?? 30);
let lastAuditLoadedAt: string | null = null;
let lastAuditWrittenAt: string | null = null;
let lastAuditError: string | null = null;

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
  auditLogMaxBytes = Number(process.env.AUDIT_LOG_MAX_BYTES ?? 5_000_000);
  auditLogMaxFiles = Number(process.env.AUDIT_LOG_MAX_FILES ?? 5);
  auditLogRetentionDays = Number(process.env.AUDIT_LOG_RETENTION_DAYS ?? 30);
  lastAuditLoadedAt = null;
  lastAuditWrittenAt = null;
  lastAuditError = null;
  leaseTtlMs = Number(process.env.LEASE_TTL_MS ?? 30_000);
  maxAttempts = Number(process.env.MAX_TASK_ATTEMPTS ?? 4);
  nowProvider = () => Date.now();
}

export function configureAuditLogPersistence(
  config?: string | { filePath?: string; maxBytes?: number; maxFiles?: number; retentionDays?: number }
): void {
  const filePath = typeof config === "string" ? config : config?.filePath;
  const maxBytes = typeof config === "object" ? config.maxBytes : undefined;
  const maxFiles = typeof config === "object" ? config.maxFiles : undefined;
  const retentionDays = typeof config === "object" ? config.retentionDays : undefined;

  if (typeof maxBytes === "number" && Number.isFinite(maxBytes) && maxBytes > 0) {
    auditLogMaxBytes = maxBytes;
  }

  if (typeof maxFiles === "number" && Number.isFinite(maxFiles) && maxFiles > 0) {
    auditLogMaxFiles = Math.floor(maxFiles);
  }

  if (typeof retentionDays === "number" && Number.isFinite(retentionDays) && retentionDays >= 0) {
    auditLogRetentionDays = retentionDays;
  }

  if (!filePath) {
    auditLogPath = null;
    return;
  }

  auditLogPath = filePath;
  ensureAuditLogLoadedFromDisk(filePath);
}

export function getAuditPersistenceStatus(): AuditPersistenceStatus {
  const enabled = Boolean(auditLogPath);
  const fileExists = enabled && auditLogPath ? fs.existsSync(auditLogPath) : false;
  const fileSizeBytes = fileExists && auditLogPath ? fs.statSync(auditLogPath).size : 0;

  let rotatedFileCount = 0;
  if (enabled && auditLogPath) {
    const dir = path.dirname(auditLogPath);
    const base = path.basename(auditLogPath);
    const rotatedPattern = new RegExp(`^${escapeRegex(base)}\\.\\d+$`);
    if (fs.existsSync(dir)) {
      rotatedFileCount = fs.readdirSync(dir).filter((name) => rotatedPattern.test(name)).length;
    }
  }

  return {
    enabled,
    path: auditLogPath,
    maxBytes: auditLogMaxBytes,
    maxFiles: auditLogMaxFiles,
    retentionDays: auditLogRetentionDays,
    fileExists,
    fileSizeBytes,
    rotatedFileCount,
    lastLoadedAt: lastAuditLoadedAt,
    lastWrittenAt: lastAuditWrittenAt,
    lastError: lastAuditError
  };
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

export function cancelTask(taskId: string): { canceled: boolean; reason?: string } {
  sweepExpiredLeases();

  const record = tasks.get(taskId);
  if (!record) {
    return { canceled: false, reason: "task_not_found" };
  }

  if (record.completed) {
    return { canceled: false, reason: "task_already_completed" };
  }

  if (record.failed) {
    return { canceled: true, reason: "task_already_failed" };
  }

  record.failed = true;
  clearLease(record);
  pushAuditEvent({
    eventType: "task_canceled",
    taskId,
    details: { attempts: record.attempts, resultCount: record.results.length }
  });

  return { canceled: true };
}

export function requeueTask(taskId: string): { requeued: boolean; reason?: string } {
  sweepExpiredLeases();

  const record = tasks.get(taskId);
  if (!record) {
    return { requeued: false, reason: "task_not_found" };
  }

  if (record.completed) {
    return { requeued: false, reason: "task_already_completed" };
  }

  if (!record.failed) {
    return { requeued: false, reason: "task_not_failed" };
  }

  record.failed = false;
  record.completed = false;
  record.results = [];
  record.attempts = 0;
  clearLease(record);
  pushAuditEvent({
    eventType: "task_requeued",
    taskId,
    details: { quorum: record.task.quorum }
  });

  return { requeued: true };
}

export function deleteTask(taskId: string): { deleted: boolean; reason?: string } {
  sweepExpiredLeases();

  const record = tasks.get(taskId);
  if (!record) {
    return { deleted: false, reason: "task_not_found" };
  }

  tasks.delete(taskId);
  pushAuditEvent({
    eventType: "task_deleted",
    taskId,
    details: {
      state: record.completed ? "completed" : record.failed ? "failed" : record.leaseOwner ? "leased" : "pending",
      attempts: record.attempts,
      resultCount: record.results.length
    }
  });

  return { deleted: true };
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

export function getTaskVerdicts(query: TaskVerdictsQuery): { found: boolean; items: TaskVerdictLogEntry[] } {
  const record = tasks.get(query.taskId);
  if (!record) {
    return { found: false, items: [] };
  }

  const items = getRecentVerdicts({
    limit: query.limit,
    taskId: query.taskId
  });

  return { found: true, items };
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

  const taskSummary = getTaskStatusSummary();
  const nodeSummary = getNodeStatusSummary();

  return {
    generatedAt: new Date(nowProvider()).toISOString(),
    queue: {
      total: tasks.size,
      pending: taskSummary.pending,
      leased: taskSummary.leased,
      completed: taskSummary.completed,
      failed: taskSummary.failed,
      retries: retryCount,
      expiredLeases: expiredLeaseCount
    },
    activeNodesLast60s: nodeSummary.active,
    totalNodes: nodeSummary.total
  };
}

export function getTaskStatusSummary(): TaskStatusSummary {
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

  return {
    total: tasks.size,
    pending,
    leased,
    completed,
    failed
  };
}

export function getNodeStatusSummary(): NodeStatusSummary {
  let active = 0;

  for (const stats of nodeStats.values()) {
    if (isNodeActive(stats)) {
      active += 1;
    }
  }

  return {
    total: nodeStats.size,
    active,
    inactive: Math.max(0, nodeStats.size - active)
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

export function listNodeStats(query: NodeListQuery): NodeStats[] {
  const bounded = Math.max(1, Math.min(200, Math.floor(query.limit)));
  const now = nowProvider();

  const items = Array.from(nodeStats.values()).filter((stats) => {
    if (!query.activeOnly) {
      return true;
    }

    if (!stats.lastSeenAt) {
      return false;
    }

    return now - new Date(stats.lastSeenAt).getTime() <= 60_000;
  });

  items.sort((a, b) => {
    const aTime = a.lastSeenAt ? new Date(a.lastSeenAt).getTime() : 0;
    const bTime = b.lastSeenAt ? new Date(b.lastSeenAt).getTime() : 0;
    return bTime - aTime;
  });

  return items.slice(0, bounded);
}

export function getNodeSnapshot(nodeId: string): NodeSnapshot | null {
  const stats = nodeStats.get(nodeId);
  if (!stats) {
    return null;
  }

  return {
    stats,
    capabilities: nodeCapabilities.get(nodeId) ?? null,
    active: isNodeActive(stats)
  };
}

export function listTaskSnapshots(query: TaskListQuery): TaskSnapshot[] {
  sweepExpiredLeases();

  const bounded = Math.max(1, Math.min(100, Math.floor(query.limit)));
  const snapshots: TaskSnapshot[] = [];

  for (const [taskId] of tasks) {
    const snapshot = getTaskSnapshot(taskId);
    if (!snapshot) {
      continue;
    }

    if (query.state && snapshot.state !== query.state) {
      continue;
    }

    snapshots.push(snapshot);
  }

  return snapshots.slice(-bounded).reverse();
}

export function getTaskSnapshot(taskId: string): TaskSnapshot | null {
  sweepExpiredLeases();

  const record = tasks.get(taskId);
  if (!record) {
    return null;
  }

  const state = getTaskState(record);

  return {
    task: record.task,
    state,
    attempts: record.attempts,
    resultCount: record.results.length,
    leaseOwner: record.leaseOwner,
    leaseExpiresAt: record.leaseExpiresAt === null ? null : new Date(record.leaseExpiresAt).toISOString()
  };
}

export function listTaskResults(query: TaskResultsQuery): { found: boolean; items: TaskResult[] } {
  sweepExpiredLeases();

  const record = tasks.get(query.taskId);
  if (!record) {
    return { found: false, items: [] };
  }

  const bounded = Math.max(1, Math.min(200, Math.floor(query.limit)));
  return {
    found: true,
    items: record.results.slice(-bounded).reverse()
  };
}

function getTaskState(record: TaskRecord): TaskSnapshot["state"] {
  if (record.completed) {
    return "completed";
  }

  if (record.failed) {
    return "failed";
  }

  if (record.leaseOwner) {
    return "leased";
  }

  return "pending";
}

function isNodeActive(stats: NodeStats): boolean {
  if (!stats.lastSeenAt) {
    return false;
  }

  return nowProvider() - new Date(stats.lastSeenAt).getTime() <= 60_000;
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
    const line = `${JSON.stringify(entry)}\n`;
    fs.mkdirSync(path.dirname(auditLogPath), { recursive: true });
    rotateAuditLogIfNeeded(auditLogPath, Buffer.byteLength(line, "utf8"));
    fs.appendFileSync(auditLogPath, line, "utf8");
    lastAuditWrittenAt = new Date(nowProvider()).toISOString();
    lastAuditError = null;
  } catch {
    lastAuditError = "audit_append_failed";
    // Persistence failures should not break API behavior in MVP mode.
  }
}

function ensureAuditLogLoadedFromDisk(filePath: string): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, "", "utf8");
      lastAuditLoadedAt = new Date(nowProvider()).toISOString();
      lastAuditError = null;
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
    lastAuditLoadedAt = new Date(nowProvider()).toISOString();
    lastAuditError = null;
  } catch {
    lastAuditError = "audit_load_failed";
    // Ignore persistence bootstrap failures in MVP mode.
  }
}

function rotateAuditLogIfNeeded(filePath: string, nextEntryBytes: number): void {
  pruneExpiredRotatedAuditFiles(filePath);

  if (auditLogMaxBytes <= 0) {
    return;
  }

  const currentSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
  if (currentSize + nextEntryBytes <= auditLogMaxBytes) {
    return;
  }

  if (auditLogMaxFiles <= 1) {
    fs.writeFileSync(filePath, "", "utf8");
    return;
  }

  const lastRotated = `${filePath}.${auditLogMaxFiles}`;
  if (fs.existsSync(lastRotated)) {
    fs.unlinkSync(lastRotated);
  }

  for (let i = auditLogMaxFiles - 1; i >= 1; i -= 1) {
    const src = `${filePath}.${i}`;
    const dst = `${filePath}.${i + 1}`;
    if (fs.existsSync(src)) {
      fs.renameSync(src, dst);
    }
  }

  if (fs.existsSync(filePath)) {
    fs.renameSync(filePath, `${filePath}.1`);
  }

  pruneExpiredRotatedAuditFiles(filePath);
}

function pruneExpiredRotatedAuditFiles(filePath: string): void {
  if (auditLogRetentionDays <= 0) {
    return;
  }

  const cutoffMs = nowProvider() - auditLogRetentionDays * 24 * 60 * 60 * 1000;
  const directory = path.dirname(filePath);
  const base = path.basename(filePath);
  const rotatedPattern = new RegExp(`^${escapeRegex(base)}\\.\\d+$`);

  if (!fs.existsSync(directory)) {
    return;
  }

  for (const name of fs.readdirSync(directory)) {
    if (!rotatedPattern.test(name)) {
      continue;
    }

    const fullPath = path.join(directory, name);
    try {
      const stat = fs.statSync(fullPath);
      if (stat.mtimeMs < cutoffMs) {
        fs.unlinkSync(fullPath);
      }
    } catch {
      continue;
    }
  }
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

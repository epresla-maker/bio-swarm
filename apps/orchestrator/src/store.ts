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

interface WorkerPackageRecord {
  packageId: string;
  name: string;
  version: string;
  runtime: string;
  entrypoint: string;
  content: string;
  checksum: string;
  createdAt: string;
}

export interface WorkerPackageView {
  packageId: string;
  name: string;
  version: string;
  runtime: string;
  entrypoint: string;
  checksum: string;
  sizeBytes: number;
  createdAt: string;
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

export interface NodeListItem {
  stats: NodeStats;
  capabilities: NodeCapabilities | null;
  active: boolean;
  control: NodeControlState;
}

export interface NodeSnapshot {
  stats: NodeStats;
  capabilities: NodeCapabilities | null;
  active: boolean;
  control: NodeControlState;
}

export type NodeControlMode = "enabled" | "disabled" | "quarantined";

export interface NodeControlState {
  mode: NodeControlMode;
  reason: string | null;
  changedAt: string | null;
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
  | "node_disabled"
  | "node_enabled"
  | "node_quarantined"
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
  enabled: number;
  disabled: number;
  quarantined: number;
}

export interface AdminDashboardTaskItem {
  snapshot: TaskSnapshot;
  reason: "failed" | "leased" | "retried_pending";
  details: {
    ageMs: number;
    attempts: number;
    resultCount: number;
    leaseAgeMs: number | null;
  };
}

export interface AdminDashboardNodeItem {
  snapshot: NodeListItem;
  reason: "disabled" | "quarantined" | "inactive" | "high_rejection_rate";
  details: {
    accepted: number;
    rejected: number;
    rejectionRate: number;
    lastSeenAgeMs: number | null;
    controlAgeMs: number | null;
  };
}

export interface AdminDashboardSnapshot {
  generatedAt: string;
  tasks: TaskStatusSummary;
  nodes: NodeStatusSummary;
  attentionTasks: AdminDashboardTaskItem[];
  attentionNodes: AdminDashboardNodeItem[];
  recentVerdicts: TaskVerdictLogEntry[];
  recentAudit: AuditLogEntry[];
  auditPersistence: AuditPersistenceStatus;
}

interface WorkerRecord {
  workerId: string;
  nodeId: string | null;
  agentVersion: string;
  platform: string;
  packageCount: number;
  lastPackageId: string | null;
  lastPackageVersion: string | null;
  lastPackageChecksum: string | null;
  lastTaskId: string | null;
  lastTaskKind: string | null;
  lastExecutionStatus: string;
  lastExecutionError: string | null;
  status: string;
  lastResultAt: string | null;
  registeredAt: string;
  lastSeenAt: string;
}

export interface WorkerSnapshot {
  workerId: string;
  nodeId: string | null;
  agentVersion: string;
  platform: string;
  packageCount: number;
  lastPackageId: string | null;
  lastPackageVersion: string | null;
  lastPackageChecksum: string | null;
  lastTaskId: string | null;
  lastTaskKind: string | null;
  lastExecutionStatus: string;
  lastExecutionError: string | null;
  status: string;
  lastResultAt: string | null;
  registeredAt: string;
  lastSeenAt: string;
}

const tasks = new Map<string, TaskRecord>();
const nodeStats = new Map<string, NodeStats>();
const nodeCapabilities = new Map<string, NodeCapabilities>();
const nodeControlStates = new Map<string, NodeControlState>();
const workers = new Map<string, WorkerRecord>();
const workerPackages = new Map<string, WorkerPackageRecord>();

let leaseTtlMs = Number(process.env.LEASE_TTL_MS ?? 30_000);
let maxAttempts = Number(process.env.MAX_TASK_ATTEMPTS ?? 4);
let autoQuarantineMinRejected = Number(process.env.AUTO_QUARANTINE_MIN_REJECTED ?? 3);
let autoUnquarantineAfterMs = Number(process.env.AUTO_UNQUARANTINE_AFTER_MS ?? 300_000);
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
  autoQuarantineMinRejected?: number;
  autoUnquarantineAfterMs?: number;
  nowProvider?: () => number;
}): void {
  if (typeof options.leaseTtlMs === "number" && Number.isFinite(options.leaseTtlMs) && options.leaseTtlMs > 0) {
    leaseTtlMs = options.leaseTtlMs;
  }

  if (typeof options.maxAttempts === "number" && Number.isFinite(options.maxAttempts) && options.maxAttempts > 0) {
    maxAttempts = options.maxAttempts;
  }

  if (
    typeof options.autoQuarantineMinRejected === "number" &&
    Number.isFinite(options.autoQuarantineMinRejected) &&
    options.autoQuarantineMinRejected > 0
  ) {
    autoQuarantineMinRejected = Math.floor(options.autoQuarantineMinRejected);
  }

  if (
    typeof options.autoUnquarantineAfterMs === "number" &&
    Number.isFinite(options.autoUnquarantineAfterMs) &&
    options.autoUnquarantineAfterMs >= 0
  ) {
    autoUnquarantineAfterMs = Math.floor(options.autoUnquarantineAfterMs);
  }

  if (options.nowProvider) {
    nowProvider = options.nowProvider;
  }
}

export function resetStoreForTests(): void {
  tasks.clear();
  nodeStats.clear();
  nodeCapabilities.clear();
  nodeControlStates.clear();
  workers.clear();
  workerPackages.clear();
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
  autoQuarantineMinRejected = Number(process.env.AUTO_QUARANTINE_MIN_REJECTED ?? 3);
  autoUnquarantineAfterMs = Number(process.env.AUTO_UNQUARANTINE_AFTER_MS ?? 300_000);
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

export function getAdminDashboardSnapshot(): AdminDashboardSnapshot {
  sweepExpiredLeases();
  const now = nowProvider();

  const attentionTasks = Array.from(tasks.keys())
    .map((taskId) => getTaskSnapshot(taskId))
    .filter((snapshot): snapshot is TaskSnapshot => snapshot !== null)
    .map((snapshot) => {
      if (snapshot.state === "failed") {
        return { snapshot, reason: "failed" as const, priority: 0 };
      }

      if (snapshot.state === "leased") {
        return { snapshot, reason: "leased" as const, priority: 1 };
      }

      if (snapshot.state === "pending" && snapshot.attempts > 0) {
        return { snapshot, reason: "retried_pending" as const, priority: 2 };
      }

      return null;
    })
    .filter((item): item is { snapshot: TaskSnapshot; reason: AdminDashboardTaskItem["reason"]; priority: number } => item !== null)
    .sort((a, b) => {
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }

      return new Date(b.snapshot.task.createdAt).getTime() - new Date(a.snapshot.task.createdAt).getTime();
    })
    .slice(0, 8)
    .map(({ snapshot, reason }) => ({
      snapshot,
      reason,
      details: {
        ageMs: Math.max(0, now - new Date(snapshot.task.createdAt).getTime()),
        attempts: snapshot.attempts,
        resultCount: snapshot.resultCount,
        leaseAgeMs:
          snapshot.state === "leased" && snapshot.leaseExpiresAt
            ? Math.max(0, leaseTtlMs - Math.max(0, new Date(snapshot.leaseExpiresAt).getTime() - now))
            : null
      }
    }));

  const attentionNodes = listNodeSnapshots({ limit: 200 })
    .map((snapshot) => {
      if (snapshot.control.mode === "disabled") {
        return { snapshot, reason: "disabled" as const, priority: 0 };
      }

      if (snapshot.control.mode === "quarantined") {
        return { snapshot, reason: "quarantined" as const, priority: 1 };
      }

      if (!snapshot.active) {
        return { snapshot, reason: "inactive" as const, priority: 2 };
      }

      if (snapshot.stats.rejected >= 2 && snapshot.stats.rejected > snapshot.stats.accepted) {
        return { snapshot, reason: "high_rejection_rate" as const, priority: 3 };
      }

      return null;
    })
    .filter((item): item is { snapshot: NodeListItem; reason: AdminDashboardNodeItem["reason"]; priority: number } => item !== null)
    .sort((a, b) => {
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }

      const aTime = a.snapshot.stats.lastSeenAt ? new Date(a.snapshot.stats.lastSeenAt).getTime() : 0;
      const bTime = b.snapshot.stats.lastSeenAt ? new Date(b.snapshot.stats.lastSeenAt).getTime() : 0;
      return bTime - aTime;
    })
    .slice(0, 8)
    .map(({ snapshot, reason }) => ({
      snapshot,
      reason,
      details: {
        accepted: snapshot.stats.accepted,
        rejected: snapshot.stats.rejected,
        rejectionRate:
          snapshot.stats.accepted + snapshot.stats.rejected > 0
            ? snapshot.stats.rejected / (snapshot.stats.accepted + snapshot.stats.rejected)
            : 0,
        lastSeenAgeMs: snapshot.stats.lastSeenAt ? Math.max(0, now - new Date(snapshot.stats.lastSeenAt).getTime()) : null,
        controlAgeMs: snapshot.control.changedAt ? Math.max(0, now - new Date(snapshot.control.changedAt).getTime()) : null
      }
    }));

  return {
    generatedAt: new Date(nowProvider()).toISOString(),
    tasks: getTaskStatusSummary(),
    nodes: getNodeStatusSummary(),
    attentionTasks,
    attentionNodes,
    recentVerdicts: getRecentVerdicts({ limit: 5 }),
    recentAudit: getAuditLog({ limit: 5 }),
    auditPersistence: getAuditPersistenceStatus()
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

export function registerWorkerPackage(input: {
  name: string;
  version: string;
  runtime: string;
  entrypoint: string;
  content: string;
}): WorkerPackageView {
  const createdAt = new Date(nowProvider()).toISOString();
  const checksum = crypto.createHash("sha256").update(input.content).digest("hex");

  const existing = Array.from(workerPackages.values()).find(
    (item) => item.name === input.name && item.version === input.version
  );

  if (existing) {
    existing.runtime = input.runtime;
    existing.entrypoint = input.entrypoint;
    existing.content = input.content;
    existing.checksum = checksum;
    existing.createdAt = createdAt;
    return toWorkerPackageView(existing);
  }

  const packageId = crypto.randomUUID();
  const record: WorkerPackageRecord = {
    packageId,
    name: input.name,
    version: input.version,
    runtime: input.runtime,
    entrypoint: input.entrypoint,
    content: input.content,
    checksum,
    createdAt
  };

  workerPackages.set(packageId, record);
  return toWorkerPackageView(record);
}

export function listWorkerPackages(limit: number): WorkerPackageView[] {
  const bounded = Math.max(1, Math.min(200, Math.floor(limit)));
  return Array.from(workerPackages.values())
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, bounded)
    .map((item) => toWorkerPackageView(item));
}

export function getWorkerPackage(packageId: string): (WorkerPackageView & { content: string }) | null {
  const record = workerPackages.get(packageId);
  if (!record) {
    return null;
  }

  return {
    ...toWorkerPackageView(record),
    content: record.content
  };
}

export function findWorkerPackage(input: {
  name: string;
  version?: string;
}): (WorkerPackageView & { content: string }) | null {
  const name = input.name.trim();
  if (!name) {
    return null;
  }

  const version = typeof input.version === "string" ? input.version.trim() : "";
  const candidates = Array.from(workerPackages.values()).filter((item) => {
    if (item.name !== name) {
      return false;
    }

    if (version && item.version !== version) {
      return false;
    }

    return true;
  });

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((a, b) => {
    const createdAtDiff = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    if (createdAtDiff !== 0) {
      return createdAtDiff;
    }

    const versionDiff = compareDotVersionsDesc(a.version, b.version);
    if (versionDiff !== 0) {
      return versionDiff;
    }

    return b.packageId.localeCompare(a.packageId);
  });
  const selected = candidates[0];

  return {
    ...toWorkerPackageView(selected),
    content: selected.content
  };
}

function compareDotVersionsDesc(a: string, b: string): number {
  const aParts = a.split(".").map((part) => Number.parseInt(part, 10));
  const bParts = b.split(".").map((part) => Number.parseInt(part, 10));
  const length = Math.max(aParts.length, bParts.length);

  for (let index = 0; index < length; index += 1) {
    const left = Number.isFinite(aParts[index]) ? aParts[index] : 0;
    const right = Number.isFinite(bParts[index]) ? bParts[index] : 0;
    if (left !== right) {
      return right - left;
    }
  }

  return b.localeCompare(a);
}

function toWorkerPackageView(item: WorkerPackageRecord): WorkerPackageView {
  return {
    packageId: item.packageId,
    name: item.name,
    version: item.version,
    runtime: item.runtime,
    entrypoint: item.entrypoint,
    checksum: item.checksum,
    sizeBytes: Buffer.byteLength(item.content, "utf8"),
    createdAt: item.createdAt
  };
}

export function claimTask(nodeId: string): SwarmTask | null {
  sweepExpiredLeases();

  if (!isNodeClaimEnabled(nodeId)) {
    return null;
  }

  for (const record of tasks.values()) {
    if (record.completed || record.failed) {
      continue;
    }

    if (!canNodeClaimTask(nodeId, record.task)) {
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

function canNodeClaimTask(nodeId: string, task: SwarmTask): boolean {
  if (task.kind !== "llm_inference") {
    return true;
  }

  const capabilities = nodeCapabilities.get(nodeId);
  if (!capabilities || capabilities.nodeClass !== "desktop_gpu" || !capabilities.gpu) {
    return false;
  }

  return typeof capabilities.gpu.vramGb === "number" && Number.isFinite(capabilities.gpu.vramGb) && capabilities.gpu.vramGb > 0;
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
  maybeAutoUnquarantineNode(nodeId);
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
  let enabled = 0;
  let disabled = 0;
  let quarantined = 0;

  for (const stats of nodeStats.values()) {
    if (isNodeActive(stats)) {
      active += 1;
    }

    const control = getNodeControlState(stats.nodeId);
    if (control.mode === "disabled") {
      disabled += 1;
    } else if (control.mode === "quarantined") {
      quarantined += 1;
    } else {
      enabled += 1;
    }
  }

  return {
    total: nodeStats.size,
    active,
    inactive: Math.max(0, nodeStats.size - active),
    enabled,
    disabled,
    quarantined
  };
}

export function updateNodeControl(
  nodeId: string,
  mode: NodeControlMode,
  reason?: string
): { found: boolean; control: NodeControlState | null } {
  if (!nodeStats.has(nodeId)) {
    return { found: false, control: null };
  }

  const control: NodeControlState = {
    mode,
    reason: typeof reason === "string" && reason.trim().length > 0 ? reason.trim() : null,
    changedAt: new Date(nowProvider()).toISOString()
  };
  nodeControlStates.set(nodeId, control);

  pushAuditEvent({
    eventType:
      mode === "disabled" ? "node_disabled" : mode === "quarantined" ? "node_quarantined" : "node_enabled",
    nodeId,
    details: control.reason ? { reason: control.reason } : undefined
  });

  return { found: true, control };
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

export function listNodeSnapshots(query: NodeListQuery): NodeListItem[] {
  const items = listNodeStats(query);

  return items.map((stats) => ({
    stats,
    capabilities: nodeCapabilities.get(stats.nodeId) ?? null,
    active: isNodeActive(stats),
    control: getNodeControlState(stats.nodeId)
  }));
}

export function getNodeSnapshot(nodeId: string): NodeSnapshot | null {
  const stats = nodeStats.get(nodeId);
  if (!stats) {
    return null;
  }

  return {
    stats,
    capabilities: nodeCapabilities.get(nodeId) ?? null,
    active: isNodeActive(stats),
    control: getNodeControlState(nodeId)
  };
}

export function registerWorker(input: {
  workerId: string;
  nodeId?: string;
  agentVersion: string;
  platform: string;
  packageCount?: number;
  lastPackageId?: string;
  lastPackageVersion?: string;
  lastPackageChecksum?: string;
  lastTaskId?: string;
  lastTaskKind?: string;
  lastExecutionStatus?: string;
  lastExecutionError?: string;
  status?: string;
  lastResultAt?: string;
}): WorkerSnapshot {
  const nowIso = new Date(nowProvider()).toISOString();
  const existing = workers.get(input.workerId);
  const registeredAt = existing?.registeredAt ?? nowIso;

  const record: WorkerRecord = {
    workerId: input.workerId,
    nodeId: typeof input.nodeId === "string" && input.nodeId.trim().length > 0 ? input.nodeId.trim() : null,
    agentVersion: input.agentVersion,
    platform: input.platform,
    packageCount: typeof input.packageCount === "number" && Number.isFinite(input.packageCount) ? Math.max(0, Math.floor(input.packageCount)) : 0,
    lastPackageId:
      typeof input.lastPackageId === "string" && input.lastPackageId.trim().length > 0 ? input.lastPackageId.trim() : null,
    lastPackageVersion:
      typeof input.lastPackageVersion === "string" && input.lastPackageVersion.trim().length > 0
        ? input.lastPackageVersion.trim()
        : null,
    lastPackageChecksum:
      typeof input.lastPackageChecksum === "string" && input.lastPackageChecksum.trim().length > 0
        ? input.lastPackageChecksum.trim()
        : null,
    lastTaskId: typeof input.lastTaskId === "string" && input.lastTaskId.trim().length > 0 ? input.lastTaskId.trim() : null,
    lastTaskKind: typeof input.lastTaskKind === "string" && input.lastTaskKind.trim().length > 0 ? input.lastTaskKind.trim() : null,
    lastExecutionStatus:
      typeof input.lastExecutionStatus === "string" && input.lastExecutionStatus.trim().length > 0
        ? input.lastExecutionStatus.trim()
        : "idle",
    lastExecutionError:
      typeof input.lastExecutionError === "string" && input.lastExecutionError.trim().length > 0
        ? input.lastExecutionError.trim()
        : null,
    status: typeof input.status === "string" && input.status.trim().length > 0 ? input.status.trim() : "idle",
    lastResultAt:
      typeof input.lastResultAt === "string" && input.lastResultAt.trim().length > 0 ? input.lastResultAt.trim() : null,
    registeredAt,
    lastSeenAt: nowIso
  };

  workers.set(input.workerId, record);
  return toWorkerSnapshot(record);
}

export function heartbeatWorker(
  workerId: string,
  input: {
    packageCount?: number;
    lastPackageId?: string;
    lastPackageVersion?: string;
    lastPackageChecksum?: string;
    lastTaskId?: string;
    lastTaskKind?: string;
    lastExecutionStatus?: string;
    lastExecutionError?: string;
    status?: string;
    lastResultAt?: string;
  }
): WorkerSnapshot | null {
  const existing = workers.get(workerId);
  if (!existing) {
    return null;
  }

  if (typeof input.packageCount === "number" && Number.isFinite(input.packageCount)) {
    existing.packageCount = Math.max(0, Math.floor(input.packageCount));
  }

  if (typeof input.lastPackageId === "string") {
    existing.lastPackageId = input.lastPackageId.trim().length > 0 ? input.lastPackageId.trim() : null;
  }

  if (typeof input.lastPackageVersion === "string") {
    existing.lastPackageVersion = input.lastPackageVersion.trim().length > 0 ? input.lastPackageVersion.trim() : null;
  }

  if (typeof input.lastPackageChecksum === "string") {
    existing.lastPackageChecksum = input.lastPackageChecksum.trim().length > 0 ? input.lastPackageChecksum.trim() : null;
  }

  if (typeof input.lastTaskId === "string") {
    existing.lastTaskId = input.lastTaskId.trim().length > 0 ? input.lastTaskId.trim() : null;
  }

  if (typeof input.lastTaskKind === "string") {
    existing.lastTaskKind = input.lastTaskKind.trim().length > 0 ? input.lastTaskKind.trim() : null;
  }

  if (typeof input.lastExecutionStatus === "string" && input.lastExecutionStatus.trim().length > 0) {
    existing.lastExecutionStatus = input.lastExecutionStatus.trim();
  }

  if (typeof input.lastExecutionError === "string") {
    existing.lastExecutionError = input.lastExecutionError.trim().length > 0 ? input.lastExecutionError.trim() : null;
  }

  if (typeof input.status === "string" && input.status.trim().length > 0) {
    existing.status = input.status.trim();
  }

  if (typeof input.lastResultAt === "string" && input.lastResultAt.trim().length > 0) {
    existing.lastResultAt = input.lastResultAt.trim();
  }

  existing.lastSeenAt = new Date(nowProvider()).toISOString();
  return toWorkerSnapshot(existing);
}

export function listWorkers(limit: number): WorkerSnapshot[] {
  const bounded = Math.max(1, Math.min(200, Math.floor(limit)));
  return Array.from(workers.values())
    .sort((a, b) => new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime())
    .slice(0, bounded)
    .map((item) => toWorkerSnapshot(item));
}

export function getWorker(workerId: string): WorkerSnapshot | null {
  const found = workers.get(workerId);
  return found ? toWorkerSnapshot(found) : null;
}

function toWorkerSnapshot(item: WorkerRecord): WorkerSnapshot {
  return {
    workerId: item.workerId,
    nodeId: item.nodeId,
    agentVersion: item.agentVersion,
    platform: item.platform,
    packageCount: item.packageCount,
    lastPackageId: item.lastPackageId,
    lastPackageVersion: item.lastPackageVersion,
    lastPackageChecksum: item.lastPackageChecksum,
    lastTaskId: item.lastTaskId,
    lastTaskKind: item.lastTaskKind,
    lastExecutionStatus: item.lastExecutionStatus,
    lastExecutionError: item.lastExecutionError,
    status: item.status,
    lastResultAt: item.lastResultAt,
    registeredAt: item.registeredAt,
    lastSeenAt: item.lastSeenAt
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

function isNodeClaimEnabled(nodeId: string): boolean {
  return getNodeControlState(nodeId).mode === "enabled";
}

function getNodeControlState(nodeId: string): NodeControlState {
  if (!nodeControlStates.has(nodeId)) {
    nodeControlStates.set(nodeId, {
      mode: "enabled",
      reason: null,
      changedAt: null
    });
  }

  return nodeControlStates.get(nodeId)!;
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

  if (!accepted) {
    maybeAutoQuarantineNode(nodeId, stats);
  }
}

function maybeAutoQuarantineNode(nodeId: string, stats: NodeStats): void {
  const control = getNodeControlState(nodeId);
  if (control.mode !== "enabled") {
    return;
  }

  if (stats.rejected < autoQuarantineMinRejected) {
    return;
  }

  if (stats.rejected <= stats.accepted) {
    return;
  }

  updateNodeControl(nodeId, "quarantined", "auto_rejection_threshold");
}

function maybeAutoUnquarantineNode(nodeId: string): void {
  const control = getNodeControlState(nodeId);
  if (control.mode !== "quarantined") {
    return;
  }

  if (control.reason !== "auto_rejection_threshold") {
    return;
  }

  if (!control.changedAt) {
    return;
  }

  const quarantinedAt = new Date(control.changedAt).getTime();
  if (!Number.isFinite(quarantinedAt)) {
    return;
  }

  if (nowProvider() - quarantinedAt < autoUnquarantineAfterMs) {
    return;
  }

  updateNodeControl(nodeId, "enabled", "auto_recovered_after_cooldown");
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

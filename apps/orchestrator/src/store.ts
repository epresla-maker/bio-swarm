import crypto from "node:crypto";
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
  leaseTtlMs = Number(process.env.LEASE_TTL_MS ?? 30_000);
  maxAttempts = Number(process.env.MAX_TASK_ATTEMPTS ?? 4);
  nowProvider = () => Date.now();
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
    return { accepted: false, reason: "task_not_found" };
  }

  if (record.completed || record.failed) {
    incrementNode(result.nodeId, false);
    pushVerdict(result.taskId, result.nodeId, false, "task_already_completed");
    return { accepted: false, reason: "task_already_completed" };
  }

  if (record.leaseOwner !== result.nodeId) {
    incrementNode(result.nodeId, false);
    pushVerdict(result.taskId, result.nodeId, false, "node_does_not_hold_lease");
    return { accepted: false, reason: "node_does_not_hold_lease" };
  }

  if (record.leaseExpiresAt !== null && nowProvider() > record.leaseExpiresAt) {
    clearLease(record);
    incrementNode(result.nodeId, false);
    pushVerdict(result.taskId, result.nodeId, false, "lease_expired");
    return { accepted: false, reason: "lease_expired" };
  }

  const duplicate = record.results.some((item) => item.nodeId === result.nodeId);
  if (duplicate) {
    incrementNode(result.nodeId, false);
    pushVerdict(result.taskId, result.nodeId, false, "duplicate_node_submission");
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

  return { accepted: true };
}

export function getRecentVerdicts(limit: number): TaskVerdictLogEntry[] {
  const bounded = Math.max(1, Math.min(100, Math.floor(limit)));
  return taskVerdicts.slice(-bounded).reverse();
}

export function recordHeartbeat(nodeId: string, capabilities?: NodeCapabilities): NodeStats {
  if (capabilities) {
    nodeCapabilities.set(nodeId, capabilities);
  }

  const stats = getNodeStats(nodeId);
  stats.heartbeats += 1;
  stats.lastSeenAt = new Date(nowProvider()).toISOString();
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

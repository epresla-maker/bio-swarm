import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  addTask,
  claimTask,
  configureAuditLogPersistence,
  configureStatePersistence,
  configureStoreRuntime,
  findWorkerPackage,
  getWorker,
  getWorkerPackage,
  getAuditLog,
  getAuditPersistenceStatus,
  getStatePersistenceStatus,
  getRecentVerdicts,
  getTaskSnapshot,
  getNodeStats,
  heartbeatWorker,
  getTelemetrySnapshot,
  listWorkerPackages,
  listWorkers,
  recordHeartbeat,
  registerWorker,
  registerWorkerPackage,
  submitResult,
  resetStoreForTests
} from "./store.js";

test("expired lease is retried by another node", () => {
  let now = 1_000;
  resetStoreForTests();
  configureStoreRuntime({
    leaseTtlMs: 100,
    maxAttempts: 3,
    nowProvider: () => now
  });

  const task = addTask({ kind: "molecule_score", payload: { smiles: "CCO" }, quorum: 1 });
  const firstClaim = claimTask("node-a");
  assert.equal(firstClaim?.id, task.id);

  now += 101;
  const secondClaim = claimTask("node-b");
  assert.equal(secondClaim?.id, task.id);

  const telemetry = getTelemetrySnapshot();
  assert.equal(telemetry.queue.expiredLeases, 1);
  assert.equal(telemetry.queue.retries, 1);
});

test("task is marked failed after max attempts are exhausted", () => {
  let now = 10_000;
  resetStoreForTests();
  configureStoreRuntime({
    leaseTtlMs: 100,
    maxAttempts: 2,
    nowProvider: () => now
  });

  addTask({ kind: "bio_prescreen", payload: { sample: "case-01" }, quorum: 1 });

  assert.ok(claimTask("node-a"));
  now += 101;
  assert.ok(claimTask("node-b"));

  now += 101;
  const thirdClaim = claimTask("node-c");
  assert.equal(thirdClaim, null);

  const telemetry = getTelemetrySnapshot();
  assert.equal(telemetry.queue.failed, 1);
  assert.equal(telemetry.queue.expiredLeases, 2);
});

test("llm_inference tasks are claimed only by central llm desktop_gpu nodes", () => {
  resetStoreForTests();

  const llmTask = addTask({
    kind: "llm_inference",
    payload: { prompt: "Summarize this", modelVersion: "bio-llm-v1" },
    quorum: 1
  });
  const generalTask = addTask({ kind: "bio_prescreen", payload: { sample: "fallback" }, quorum: 1 });

  recordHeartbeat("node-mobile", {
    charging: true,
    wifi: true,
    idle: true,
    userOptIn: true,
    nodeClass: "mobile"
  });

  const mobileClaim = claimTask("node-mobile");
  assert.equal(mobileClaim?.id, generalTask.id);
  assert.equal(mobileClaim?.kind, "bio_prescreen");

  const mobileClaimAgain = claimTask("node-mobile");
  assert.equal(mobileClaimAgain, null);

  recordHeartbeat("node-gpu-generic", {
    charging: true,
    wifi: true,
    idle: true,
    userOptIn: true,
    nodeClass: "desktop_gpu",
    gpu: {
      vendor: "nvidia",
      model: "rtx-4080",
      vramGb: 16
    }
  });

  const genericGpuClaim = claimTask("node-gpu-generic");
  assert.equal(genericGpuClaim, null);

  recordHeartbeat("node-gpu", {
    charging: true,
    wifi: true,
    idle: true,
    userOptIn: true,
    nodeClass: "desktop_gpu",
    gpu: {
      vendor: "nvidia",
      model: "rtx-4090",
      vramGb: 24
    },
    llm: {
      role: "central_host",
      modelVersions: ["bio-llm-v1"]
    }
  });

  const gpuClaim = claimTask("node-gpu");
  assert.equal(gpuClaim?.id, llmTask.id);
  assert.equal(gpuClaim?.kind, "llm_inference");
});

test("llm_inference routing requires matching central model version", () => {
  resetStoreForTests();

  const llmTask = addTask({
    kind: "llm_inference",
    payload: { prompt: "Explain this sample", modelVersion: "bio-llm-v2" },
    quorum: 1
  });

  recordHeartbeat("node-gpu-v1", {
    charging: true,
    wifi: true,
    idle: true,
    userOptIn: true,
    nodeClass: "desktop_gpu",
    gpu: {
      vendor: "nvidia",
      model: "rtx-4090",
      vramGb: 24
    },
    llm: {
      role: "central_host",
      modelVersions: ["bio-llm-v1"]
    }
  });

  assert.equal(claimTask("node-gpu-v1"), null);

  recordHeartbeat("node-gpu-v2", {
    charging: true,
    wifi: true,
    idle: true,
    userOptIn: true,
    nodeClass: "desktop_gpu",
    gpu: {
      vendor: "nvidia",
      model: "rtx-5090",
      vramGb: 32
    },
    llm: {
      role: "central_host",
      modelVersions: ["bio-llm-v2", "bio-llm-v3"]
    }
  });

  const claim = claimTask("node-gpu-v2");
  assert.equal(claim?.id, llmTask.id);
});

test("claimTask respects supported task kinds filter", () => {
  resetStoreForTests();

  const llmTask = addTask({
    kind: "llm_inference",
    payload: { prompt: "Route only llm", modelVersion: "bio-llm-v1" },
    quorum: 1
  });

  recordHeartbeat("node-central-filter", {
    charging: true,
    wifi: true,
    idle: true,
    userOptIn: true,
    nodeClass: "desktop_gpu",
    gpu: {
      vendor: "nvidia",
      model: "rtx-5090",
      vramGb: 32
    },
    llm: {
      role: "central_host",
      modelVersions: ["bio-llm-v1"]
    }
  });

  const denied = claimTask("node-central-filter", {
    supportedKinds: new Set(["bio_prescreen", "package_execute"])
  });
  assert.equal(denied, null);

  const allowed = claimTask("node-central-filter", {
    supportedKinds: new Set(["llm_inference"])
  });
  assert.equal(allowed?.id, llmTask.id);
});

test("heartbeat updates node stats and active node count", () => {
  let now = 20_000;
  resetStoreForTests();
  configureStoreRuntime({ nowProvider: () => now });

  recordHeartbeat("node-h1", {
    charging: true,
    wifi: true,
    idle: true,
    userOptIn: true
  });

  now += 250;
  recordHeartbeat("node-h1");

  const stats = getNodeStats("node-h1");
  const telemetry = getTelemetrySnapshot();

  assert.equal(stats.heartbeats, 2);
  assert.equal(stats.lastSeenAt, new Date(now).toISOString());
  assert.equal(telemetry.totalNodes, 1);
  assert.equal(telemetry.activeNodesLast60s, 1);
});

test("recent verdicts returns newest first and respects limit", () => {
  let now = 30_000;
  resetStoreForTests();
  configureStoreRuntime({ nowProvider: () => now });

  const task = addTask({ kind: "bio_prescreen", payload: { sample: "v1" }, quorum: 2 });
  assert.ok(claimTask("node-v1"));

  now += 1;
  const accepted = submitResult({
    taskId: task.id,
    nodeId: "node-v1",
    checksum: "sum-1",
    score: 0.8,
    payload: {},
    submittedAt: new Date(now).toISOString()
  });
  assert.equal(accepted.accepted, true);

  now += 1;
  const rejected = submitResult({
    taskId: task.id,
    nodeId: "node-v1",
    checksum: "sum-2",
    score: 0.7,
    payload: {},
    submittedAt: new Date(now).toISOString()
  });
  assert.equal(rejected.accepted, false);

  const verdicts = getRecentVerdicts({ limit: 2 });
  assert.equal(verdicts.length, 2);
  assert.equal(verdicts[0].accepted, false);
  assert.equal(verdicts[1].accepted, true);

  const acceptedOnly = getRecentVerdicts({ limit: 10, accepted: true });
  assert.equal(acceptedOnly.length, 1);
  assert.equal(acceptedOnly[0].accepted, true);

  const byTask = getRecentVerdicts({ limit: 10, taskId: task.id });
  assert.equal(byTask.length, 2);
});

test("audit log supports filtering by node, event type and time range", () => {
  let now = 40_000;
  resetStoreForTests();
  configureStoreRuntime({ nowProvider: () => now, leaseTtlMs: 100, maxAttempts: 3 });

  const task = addTask({ kind: "molecule_score", payload: { smiles: "CO" }, quorum: 1 });
  recordHeartbeat("node-a", { charging: true, wifi: true, idle: true, userOptIn: true });

  now += 1;
  claimTask("node-a");

  now += 1;
  submitResult({
    taskId: task.id,
    nodeId: "node-a",
    checksum: "audit-1",
    score: 0.9,
    payload: {},
    submittedAt: new Date(now).toISOString()
  });

  const byNode = getAuditLog({ limit: 20, nodeId: "node-a" });
  assert.ok(byNode.length >= 3);

  const claimsOnly = getAuditLog({ limit: 20, eventType: "task_claimed" });
  assert.equal(claimsOnly.length, 1);
  assert.equal(claimsOnly[0].taskId, task.id);

  const range = getAuditLog({ limit: 20, since: now - 1, until: now });
  assert.ok(range.some((item) => item.eventType === "result_submitted"));
});

test("audit log persists to disk and can be loaded again", () => {
  let now = 50_000;
  resetStoreForTests();
  configureStoreRuntime({ nowProvider: () => now });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bio-swarm-audit-"));
  const file = path.join(dir, "audit.jsonl");

  configureAuditLogPersistence(file);
  addTask({ kind: "bio_prescreen", payload: { sample: "persist" }, quorum: 1 });

  const text = fs.readFileSync(file, "utf8");
  assert.ok(text.includes("task_created"));

  resetStoreForTests();
  configureAuditLogPersistence(file);
  const loaded = getAuditLog({ limit: 10, eventType: "task_created" });
  assert.equal(loaded.length, 1);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("audit log rotates when file exceeds max bytes", () => {
  resetStoreForTests();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bio-swarm-audit-rotate-"));
  const file = path.join(dir, "audit.jsonl");

  configureAuditLogPersistence({ filePath: file, maxBytes: 120, maxFiles: 2 });
  addTask({ kind: "bio_prescreen", payload: { sample: "rotate-1" }, quorum: 1 });
  addTask({ kind: "bio_prescreen", payload: { sample: "rotate-2" }, quorum: 1 });
  addTask({ kind: "bio_prescreen", payload: { sample: "rotate-3" }, quorum: 1 });

  assert.equal(fs.existsSync(file), true);
  assert.equal(fs.existsSync(`${file}.1`), true);
  assert.equal(fs.existsSync(`${file}.2`), true);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("audit log retention removes old rotated files", () => {
  let now = 200_000_000;
  resetStoreForTests();
  configureStoreRuntime({ nowProvider: () => now });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bio-swarm-audit-retention-"));
  const file = path.join(dir, "audit.jsonl");
  const oldRotated = `${file}.9`;
  const recentRotated = `${file}.8`;

  fs.writeFileSync(oldRotated, "old\n", "utf8");
  fs.writeFileSync(recentRotated, "recent\n", "utf8");

  const dayMs = 24 * 60 * 60 * 1000;
  fs.utimesSync(oldRotated, new Date(now - 2 * dayMs), new Date(now - 2 * dayMs));
  fs.utimesSync(recentRotated, new Date(now - dayMs / 2), new Date(now - dayMs / 2));

  configureAuditLogPersistence({ filePath: file, maxBytes: 5000000, maxFiles: 5, retentionDays: 1 });
  addTask({ kind: "bio_prescreen", payload: { sample: "retention" }, quorum: 1 });

  assert.equal(fs.existsSync(oldRotated), false);
  assert.equal(fs.existsSync(recentRotated), true);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("audit persistence status reports runtime configuration", () => {
  resetStoreForTests();

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bio-swarm-audit-status-"));
  const file = path.join(dir, "audit.jsonl");

  configureAuditLogPersistence({ filePath: file, maxBytes: 2048, maxFiles: 3, retentionDays: 7 });
  addTask({ kind: "bio_prescreen", payload: { sample: "status" }, quorum: 1 });

  const status = getAuditPersistenceStatus();
  assert.equal(status.enabled, true);
  assert.equal(status.path, file);
  assert.equal(status.maxBytes, 2048);
  assert.equal(status.maxFiles, 3);
  assert.equal(status.retentionDays, 7);
  assert.equal(status.fileExists, true);
  assert.ok(status.fileSizeBytes > 0);
  assert.equal(status.lastError, null);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("worker package registry stores and updates by name/version", () => {
  resetStoreForTests();

  const first = registerWorkerPackage({
    name: "sim-kernel",
    version: "1.0.0",
    runtime: "node",
    entrypoint: "index.js",
    content: "export const version = '1.0.0';"
  });

  assert.equal(first.name, "sim-kernel");
  assert.equal(first.version, "1.0.0");
  assert.ok(first.sizeBytes > 0);

  const listed = listWorkerPackages(10);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].packageId, first.packageId);

  const fetched = getWorkerPackage(first.packageId);
  assert.equal(fetched?.packageId, first.packageId);
  assert.equal(typeof fetched?.content, "string");

  const updated = registerWorkerPackage({
    name: "sim-kernel",
    version: "1.0.0",
    runtime: "node",
    entrypoint: "index.js",
    content: "export const version = '1.0.0'; export const patch = 1;"
  });

  assert.equal(updated.packageId, first.packageId);
  assert.notEqual(updated.checksum, first.checksum);
  assert.equal(listWorkerPackages(10).length, 1);
});

test("worker package registry includes signature when PACKAGE_SIGNING_KEY is set", () => {
  resetStoreForTests();
  const previousKey = process.env.PACKAGE_SIGNING_KEY;
  process.env.PACKAGE_SIGNING_KEY = "test-signing-key";

  try {
    const created = registerWorkerPackage({
      name: "signed-kernel",
      version: "1.0.0",
      runtime: "node",
      entrypoint: "index.js",
      content: "export const signed = true;"
    });

    assert.equal(created.signatureAlgorithm, "hmac-sha256");
    assert.equal(typeof created.signature, "string");
    assert.ok((created.signature ?? "").length > 10);
  } finally {
    if (typeof previousKey === "string") {
      process.env.PACKAGE_SIGNING_KEY = previousKey;
    } else {
      delete process.env.PACKAGE_SIGNING_KEY;
    }
  }
});

test("worker package registry stores declared permissions", () => {
  resetStoreForTests();

  const created = registerWorkerPackage({
    name: "policy-kernel",
    version: "1.0.0",
    runtime: "node",
    entrypoint: "index.js",
    permissions: ["environment", "filesystem"],
    content: "export const policy = true;"
  });

  assert.deepEqual(created.permissions, ["environment", "filesystem"]);
});

test("worker package registry resolves by name and optional version", () => {
  resetStoreForTests();

  const v1 = registerWorkerPackage({
    name: "sim-kernel",
    version: "1.0.0",
    runtime: "node",
    entrypoint: "index.js",
    content: "export const v = '1.0.0';"
  });

  const v2 = registerWorkerPackage({
    name: "sim-kernel",
    version: "1.1.0",
    runtime: "node",
    entrypoint: "index.js",
    content: "export const v = '1.1.0';"
  });

  const latest = findWorkerPackage({ name: "sim-kernel" });
  assert.equal(latest?.packageId, v2.packageId);

  const exact = findWorkerPackage({ name: "sim-kernel", version: "1.0.0" });
  assert.equal(exact?.packageId, v1.packageId);

  const missing = findWorkerPackage({ name: "sim-kernel", version: "9.9.9" });
  assert.equal(missing, null);
});

test("worker registry tracks registration and heartbeat updates", () => {
  resetStoreForTests();

  const registered = registerWorker({
    workerId: "worker-a",
    nodeId: "node-a",
    agentVersion: "worker/0.1.0",
    platform: "darwin-arm64",
    status: "running",
    packageCount: 1
  });

  assert.equal(registered.workerId, "worker-a");
  assert.equal(registered.nodeId, "node-a");
  assert.equal(registered.status, "running");

  const listed = listWorkers(10);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].workerId, "worker-a");

  const heartbeat = heartbeatWorker("worker-a", {
    status: "idle",
    packageCount: 2,
    lastPackageId: "pkg-1",
    lastPackageVersion: "1.1.0",
    lastPackageChecksum: "abc123",
    lastTaskId: "task-7",
    lastTaskKind: "package_execute",
    lastExecutionStatus: "completed",
    lastExecutionError: ""
  });
  assert.equal(heartbeat?.status, "idle");
  assert.equal(heartbeat?.packageCount, 2);
  assert.equal(heartbeat?.lastPackageId, "pkg-1");
  assert.equal(heartbeat?.lastPackageVersion, "1.1.0");
  assert.equal(heartbeat?.lastTaskId, "task-7");
  assert.equal(heartbeat?.lastTaskKind, "package_execute");
  assert.equal(heartbeat?.lastExecutionStatus, "completed");
  assert.equal(heartbeat?.lastExecutionError, null);

  const fetched = getWorker("worker-a");
  assert.equal(fetched?.workerId, "worker-a");
  assert.equal(fetched?.status, "idle");

  const missingHeartbeat = heartbeatWorker("worker-missing", { status: "idle" });
  assert.equal(missingHeartbeat, null);
});

test("listWorkers supports errorsOnly filtering", () => {
  resetStoreForTests();

  registerWorker({
    workerId: "worker-ok",
    nodeId: "node-ok",
    agentVersion: "worker/0.1.0",
    platform: "darwin-arm64",
    status: "running",
    lastExecutionStatus: "completed"
  });

  registerWorker({
    workerId: "worker-err",
    nodeId: "node-err",
    agentVersion: "worker/0.1.0",
    platform: "darwin-arm64",
    status: "running",
    lastExecutionStatus: "completed_with_error",
    lastExecutionError: "checksum_mismatch"
  });

  const allWorkers = listWorkers({ limit: 10 });
  assert.equal(allWorkers.length, 2);

  const errorWorkers = listWorkers({ limit: 10, errorsOnly: true });
  assert.equal(errorWorkers.length, 1);
  assert.equal(errorWorkers[0].workerId, "worker-err");
});

test("addTask signs task envelope when TASK_SIGNING_KEY is set", () => {
  resetStoreForTests();
  const previousKey = process.env.TASK_SIGNING_KEY;
  const previousTtl = process.env.TASK_SIGNATURE_TTL_MS;
  process.env.TASK_SIGNING_KEY = "task-sign-key";
  process.env.TASK_SIGNATURE_TTL_MS = "60000";

  try {
    const task = addTask({ kind: "bio_prescreen", payload: { sample: "signed" }, quorum: 1 });
    assert.equal(task.signatureAlgorithm, "hmac-sha256");
    assert.equal(typeof task.signature, "string");
    assert.equal(typeof task.expiresAt, "string");
  } finally {
    if (typeof previousKey === "string") {
      process.env.TASK_SIGNING_KEY = previousKey;
    } else {
      delete process.env.TASK_SIGNING_KEY;
    }

    if (typeof previousTtl === "string") {
      process.env.TASK_SIGNATURE_TTL_MS = previousTtl;
    } else {
      delete process.env.TASK_SIGNATURE_TTL_MS;
    }
  }
});

test("state snapshot persistence saves and reloads queue state", () => {
  resetStoreForTests();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bio-swarm-state-"));
  const file = path.join(dir, "state.json");

  configureStatePersistence(file);

  const task = addTask({ kind: "bio_prescreen", payload: { sample: "persist-state" }, quorum: 1 });
  const claim = claimTask("node-state");
  assert.equal(claim?.id, task.id);
  registerWorker({
    workerId: "worker-state",
    nodeId: "node-state",
    agentVersion: "worker/0.1.0",
    platform: "darwin-arm64",
    status: "running"
  });
  registerWorkerPackage({
    name: "state-kernel",
    version: "1.0.0",
    runtime: "node",
    entrypoint: "index.js",
    content: "export const ok = true;"
  });

  const statusBefore = getStatePersistenceStatus();
  assert.equal(statusBefore.enabled, true);
  assert.equal(statusBefore.fileExists, true);

  resetStoreForTests();
  configureStatePersistence(file);

  const restoredTask = getTaskSnapshot(task.id);
  assert.equal(restoredTask?.task.id, task.id);
  assert.equal(restoredTask?.state, "leased");
  assert.equal(getWorker("worker-state")?.workerId, "worker-state");
  assert.equal(getWorkerPackage(listWorkerPackages(10)[0].packageId)?.name, "state-kernel");
  assert.equal(getNodeStats("node-state").lastSeenAt !== null, true);
});
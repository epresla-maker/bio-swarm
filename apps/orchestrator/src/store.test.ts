import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  addTask,
  claimTask,
  configureAuditLogPersistence,
  configureStoreRuntime,
  getAuditLog,
  getAuditPersistenceStatus,
  getRecentVerdicts,
  getNodeStats,
  getTelemetrySnapshot,
  recordHeartbeat,
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

test("llm_inference tasks are claimed only by desktop_gpu nodes", () => {
  resetStoreForTests();

  const llmTask = addTask({
    kind: "llm_inference",
    payload: { prompt: "Summarize this" },
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
    }
  });

  const gpuClaim = claimTask("node-gpu");
  assert.equal(gpuClaim?.id, llmTask.id);
  assert.equal(gpuClaim?.kind, "llm_inference");
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
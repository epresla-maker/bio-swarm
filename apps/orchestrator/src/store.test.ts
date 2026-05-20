import assert from "node:assert/strict";
import test from "node:test";
import {
  addTask,
  claimTask,
  configureStoreRuntime,
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

  const verdicts = getRecentVerdicts(2);
  assert.equal(verdicts.length, 2);
  assert.equal(verdicts[0].accepted, false);
  assert.equal(verdicts[1].accepted, true);
});
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { buildApp } from "./app.js";
import { configureStoreRuntime, resetStoreForTests } from "./store.js";

beforeEach(() => {
  resetStoreForTests();
});

test("GET /health returns ok", async (t) => {
  const app = buildApp();
  t.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/health" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { ok: true });
});

test("heartbeat updates node stats and telemetry", async (t) => {
  const app = buildApp();
  t.after(() => app.close());

  const heartbeat = await app.inject({
    method: "POST",
    url: "/nodes/node-h1/heartbeat",
    payload: {
      capabilities: {
        charging: true,
        wifi: true,
        idle: true,
        userOptIn: true
      }
    }
  });

  assert.equal(heartbeat.statusCode, 200);
  const stats = await app.inject({ method: "GET", url: "/nodes/node-h1/stats" });
  assert.equal(stats.statusCode, 200);
  assert.equal(stats.json().heartbeats, 1);

  const telemetry = await app.inject({ method: "GET", url: "/telemetry" });
  assert.equal(telemetry.statusCode, 200);
  assert.equal(telemetry.json().totalNodes, 1);
});

test("GET /nodes lists and filters active nodes", async (t) => {
  let now = 10_000;
  configureStoreRuntime({ nowProvider: () => now });
  const app = buildApp({ adminApiKey: "node-list-key", nowProvider: () => now });
  t.after(() => app.close());

  const hb1 = await app.inject({ method: "POST", url: "/nodes/node-a/heartbeat", payload: {} });
  assert.equal(hb1.statusCode, 200);

  const disabled = await app.inject({
    method: "POST",
    url: "/nodes/node-a/disable",
    headers: { "x-admin-key": "node-list-key" },
    payload: { reason: "manual_hold" }
  });
  assert.equal(disabled.statusCode, 200);

  now += 61_000;
  const hb2 = await app.inject({ method: "POST", url: "/nodes/node-b/heartbeat", payload: {} });
  assert.equal(hb2.statusCode, 200);

  const all = await app.inject({ method: "GET", url: "/nodes?limit=10" });
  assert.equal(all.statusCode, 200);
  assert.equal(all.json().items.length, 2);
  assert.equal(all.json().items[0].stats.nodeId, "node-b");
  assert.equal(all.json().items[0].control.mode, "enabled");
  assert.equal(all.json().items[1].stats.nodeId, "node-a");
  assert.equal(all.json().items[1].control.mode, "disabled");

  const activeOnly = await app.inject({ method: "GET", url: "/nodes?active=true&limit=10" });
  assert.equal(activeOnly.statusCode, 200);
  assert.equal(activeOnly.json().items.length, 1);
  assert.equal(activeOnly.json().items[0].stats.nodeId, "node-b");
  assert.equal(activeOnly.json().items[0].active, true);

  const includeInactive = await app.inject({ method: "GET", url: "/nodes?active=false&limit=10" });
  assert.equal(includeInactive.statusCode, 200);
  assert.equal(includeInactive.json().items.length, 2);

  const invalidActive = await app.inject({ method: "GET", url: "/nodes?active=maybe" });
  assert.equal(invalidActive.statusCode, 400);

  const invalidLimit = await app.inject({ method: "GET", url: "/nodes?limit=0" });
  assert.equal(invalidLimit.statusCode, 400);
});

test("GET /nodes/:id returns node snapshot", async (t) => {
  let now = 20_000;
  configureStoreRuntime({ nowProvider: () => now });
  const app = buildApp({ nowProvider: () => now });
  t.after(() => app.close());

  const missing = await app.inject({ method: "GET", url: "/nodes/missing" });
  assert.equal(missing.statusCode, 404);

  const heartbeat = await app.inject({
    method: "POST",
    url: "/nodes/node-snapshot/heartbeat",
    payload: {
      capabilities: {
        charging: true,
        wifi: true,
        idle: false,
        userOptIn: true
      }
    }
  });
  assert.equal(heartbeat.statusCode, 200);

  const current = await app.inject({ method: "GET", url: "/nodes/node-snapshot" });
  assert.equal(current.statusCode, 200);
  assert.equal(current.json().active, true);
  assert.equal(current.json().stats.nodeId, "node-snapshot");
  assert.equal(current.json().capabilities.charging, true);
  assert.equal(current.json().control.mode, "enabled");

  now += 61_000;
  const stale = await app.inject({ method: "GET", url: "/nodes/node-snapshot" });
  assert.equal(stale.statusCode, 200);
  assert.equal(stale.json().active, false);
});

test("node operator controls block claims until re-enabled", async (t) => {
  const app = buildApp({ adminApiKey: "node-ops-key" });
  t.after(() => app.close());

  await app.inject({ method: "POST", url: "/nodes/node-policy/heartbeat", payload: {} });

  const created = await app.inject({
    method: "POST",
    url: "/tasks",
    headers: { "x-admin-key": "node-ops-key" },
    payload: {
      kind: "bio_prescreen",
      payload: { sample: "policy-1" },
      quorum: 1
    }
  });
  assert.equal(created.statusCode, 201);

  const unauthorizedDisable = await app.inject({ method: "POST", url: "/nodes/node-policy/disable" });
  assert.equal(unauthorizedDisable.statusCode, 401);

  const disabled = await app.inject({
    method: "POST",
    url: "/nodes/node-policy/disable",
    headers: { "x-admin-key": "node-ops-key" },
    payload: { reason: "manual_hold" }
  });
  assert.equal(disabled.statusCode, 200);
  assert.equal(disabled.json().control.mode, "disabled");
  assert.equal(disabled.json().control.reason, "manual_hold");

  const disabledClaim = await app.inject({ method: "GET", url: "/tasks/claim?nodeId=node-policy" });
  assert.equal(disabledClaim.statusCode, 204);

  const quarantined = await app.inject({
    method: "POST",
    url: "/nodes/node-policy/quarantine",
    headers: { "x-admin-key": "node-ops-key" },
    payload: { reason: "suspicious_scores" }
  });
  assert.equal(quarantined.statusCode, 200);
  assert.equal(quarantined.json().control.mode, "quarantined");

  const quarantinedClaim = await app.inject({ method: "GET", url: "/tasks/claim?nodeId=node-policy" });
  assert.equal(quarantinedClaim.statusCode, 204);

  const enabled = await app.inject({
    method: "POST",
    url: "/nodes/node-policy/enable",
    headers: { "x-admin-key": "node-ops-key" }
  });
  assert.equal(enabled.statusCode, 200);
  assert.equal(enabled.json().control.mode, "enabled");
  assert.equal(enabled.json().control.reason, null);

  const claim = await app.inject({ method: "GET", url: "/tasks/claim?nodeId=node-policy" });
  assert.equal(claim.statusCode, 200);

  const snapshot = await app.inject({ method: "GET", url: "/nodes/node-policy" });
  assert.equal(snapshot.statusCode, 200);
  assert.equal(snapshot.json().control.mode, "enabled");

  const audit = await app.inject({
    method: "GET",
    url: "/nodes/node-policy/audit?limit=10",
    headers: { "x-admin-key": "node-ops-key" }
  });
  assert.equal(audit.statusCode, 200);
  assert.ok(audit.json().items.some((item: { eventType: string }) => item.eventType === "node_disabled"));
  assert.ok(audit.json().items.some((item: { eventType: string }) => item.eventType === "node_quarantined"));
  assert.ok(audit.json().items.some((item: { eventType: string }) => item.eventType === "node_enabled"));
});

test("llm_inference claim routing prefers desktop_gpu nodes", async (t) => {
  const app = buildApp({ adminApiKey: "gpu-routing-key" });
  t.after(() => app.close());

  const mobileHeartbeat = await app.inject({
    method: "POST",
    url: "/nodes/node-mobile/heartbeat",
    payload: {
      capabilities: {
        charging: true,
        wifi: true,
        idle: true,
        userOptIn: true,
        nodeClass: "mobile"
      }
    }
  });
  assert.equal(mobileHeartbeat.statusCode, 200);

  const desktopHeartbeat = await app.inject({
    method: "POST",
    url: "/nodes/node-desktop/heartbeat",
    payload: {
      capabilities: {
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
      }
    }
  });
  assert.equal(desktopHeartbeat.statusCode, 200);

  const llmCreated = await app.inject({
    method: "POST",
    url: "/tasks",
    headers: { "x-admin-key": "gpu-routing-key" },
    payload: {
      kind: "llm_inference",
      payload: { prompt: "Summarize the sample" },
      quorum: 1
    }
  });
  assert.equal(llmCreated.statusCode, 201);

  const normalCreated = await app.inject({
    method: "POST",
    url: "/tasks",
    headers: { "x-admin-key": "gpu-routing-key" },
    payload: {
      kind: "bio_prescreen",
      payload: { sample: "route-fallback" },
      quorum: 1
    }
  });
  assert.equal(normalCreated.statusCode, 201);

  const mobileClaim = await app.inject({ method: "GET", url: "/tasks/claim?nodeId=node-mobile" });
  assert.equal(mobileClaim.statusCode, 200);
  assert.equal(mobileClaim.json().kind, "bio_prescreen");
  assert.equal(mobileClaim.json().id, normalCreated.json().id);

  const desktopClaim = await app.inject({ method: "GET", url: "/tasks/claim?nodeId=node-desktop" });
  assert.equal(desktopClaim.statusCode, 200);
  assert.equal(desktopClaim.json().kind, "llm_inference");
  assert.equal(desktopClaim.json().id, llmCreated.json().id);
});

test("node is automatically quarantined after repeated rejected results", async (t) => {
  configureStoreRuntime({ autoQuarantineMinRejected: 3 });
  const app = buildApp({ adminApiKey: "auto-quarantine-key" });
  t.after(() => app.close());

  await app.inject({ method: "POST", url: "/nodes/node-auto/heartbeat", payload: {} });

  for (let index = 0; index < 3; index += 1) {
    const rejected = await app.inject({
      method: "POST",
      url: `/tasks/missing-${index}/result`,
      payload: {
        nodeId: "node-auto",
        checksum: `bad-${index}`,
        score: 0.1,
        payload: {}
      }
    });
    assert.equal(rejected.statusCode, 409);
    assert.equal(rejected.json().reason, "task_not_found");
  }

  const snapshot = await app.inject({ method: "GET", url: "/nodes/node-auto" });
  assert.equal(snapshot.statusCode, 200);
  assert.equal(snapshot.json().stats.rejected, 3);
  assert.equal(snapshot.json().control.mode, "quarantined");
  assert.equal(snapshot.json().control.reason, "auto_rejection_threshold");

  const created = await app.inject({
    method: "POST",
    url: "/tasks",
    headers: { "x-admin-key": "auto-quarantine-key" },
    payload: {
      kind: "bio_prescreen",
      payload: { sample: "blocked-after-auto-quarantine" },
      quorum: 1
    }
  });
  assert.equal(created.statusCode, 201);

  const claim = await app.inject({ method: "GET", url: "/tasks/claim?nodeId=node-auto" });
  assert.equal(claim.statusCode, 204);

  const audit = await app.inject({
    method: "GET",
    url: "/nodes/node-auto/audit?limit=10",
    headers: { "x-admin-key": "auto-quarantine-key" }
  });
  assert.equal(audit.statusCode, 200);
  assert.ok(audit.json().items.some((item: { eventType: string; details?: { reason?: string } }) => item.eventType === "node_quarantined" && item.details?.reason === "auto_rejection_threshold"));
});

test("auto-quarantined node is re-enabled after cooldown on fresh heartbeat", async (t) => {
  let now = 100_000;
  configureStoreRuntime({
    autoQuarantineMinRejected: 2,
    autoUnquarantineAfterMs: 1_000,
    nowProvider: () => now
  });
  const app = buildApp({ adminApiKey: "auto-recover-key", nowProvider: () => now });
  t.after(() => app.close());

  await app.inject({ method: "POST", url: "/nodes/node-recover/heartbeat", payload: {} });

  for (let index = 0; index < 2; index += 1) {
    const rejected = await app.inject({
      method: "POST",
      url: `/tasks/missing-recover-${index}/result`,
      payload: {
        nodeId: "node-recover",
        checksum: `recover-bad-${index}`,
        score: 0.2,
        payload: {}
      }
    });
    assert.equal(rejected.statusCode, 409);
  }

  let snapshot = await app.inject({ method: "GET", url: "/nodes/node-recover" });
  assert.equal(snapshot.statusCode, 200);
  assert.equal(snapshot.json().control.mode, "quarantined");
  assert.equal(snapshot.json().control.reason, "auto_rejection_threshold");

  now += 1_500;

  const recoveredHeartbeat = await app.inject({ method: "POST", url: "/nodes/node-recover/heartbeat", payload: {} });
  assert.equal(recoveredHeartbeat.statusCode, 200);

  snapshot = await app.inject({ method: "GET", url: "/nodes/node-recover" });
  assert.equal(snapshot.statusCode, 200);
  assert.equal(snapshot.json().control.mode, "enabled");
  assert.equal(snapshot.json().control.reason, "auto_recovered_after_cooldown");

  const created = await app.inject({
    method: "POST",
    url: "/tasks",
    headers: { "x-admin-key": "auto-recover-key" },
    payload: {
      kind: "bio_prescreen",
      payload: { sample: "auto-recovered" },
      quorum: 1
    }
  });
  assert.equal(created.statusCode, 201);

  const claim = await app.inject({ method: "GET", url: "/tasks/claim?nodeId=node-recover" });
  assert.equal(claim.statusCode, 200);

  const audit = await app.inject({
    method: "GET",
    url: "/nodes/node-recover/audit?limit=10",
    headers: { "x-admin-key": "auto-recover-key" }
  });
  assert.equal(audit.statusCode, 200);
  assert.ok(audit.json().items.some((item: { eventType: string; details?: { reason?: string } }) => item.eventType === "node_enabled" && item.details?.reason === "auto_recovered_after_cooldown"));
});

test("GET /nodes/:id/audit returns node-specific audit history", async (t) => {
  let now = 25_000;
  configureStoreRuntime({ nowProvider: () => now });
  const app = buildApp({ adminApiKey: "node-audit-key", nowProvider: () => now });
  t.after(() => app.close());

  const missing = await app.inject({
    method: "GET",
    url: "/nodes/missing/audit",
    headers: { "x-admin-key": "node-audit-key" }
  });
  assert.equal(missing.statusCode, 404);

  await app.inject({
    method: "POST",
    url: "/nodes/node-audit/heartbeat",
    payload: {
      capabilities: {
        charging: true,
        wifi: true,
        idle: true,
        userOptIn: true
      }
    }
  });

  const created = await app.inject({
    method: "POST",
    url: "/tasks",
    headers: { "x-admin-key": "node-audit-key" },
    payload: {
      kind: "bio_prescreen",
      payload: { sample: "node-audit" },
      quorum: 1
    }
  });
  const task = created.json();

  now += 1;
  await app.inject({ method: "GET", url: "/tasks/claim?nodeId=node-audit" });

  now += 1;
  await app.inject({
    method: "POST",
    url: `/tasks/${task.id}/result`,
    payload: {
      nodeId: "node-audit",
      checksum: "node-audit-ok",
      score: 0.72,
      payload: {}
    }
  });

  const unauthorized = await app.inject({ method: "GET", url: "/nodes/node-audit/audit" });
  assert.equal(unauthorized.statusCode, 401);

  const all = await app.inject({
    method: "GET",
    url: "/nodes/node-audit/audit?limit=10",
    headers: { "x-admin-key": "node-audit-key" }
  });
  assert.equal(all.statusCode, 200);
  assert.ok(all.json().items.length >= 3);
  assert.ok(all.json().items.every((item: { nodeId?: string }) => item.nodeId === "node-audit"));

  const heartbeatOnly = await app.inject({
    method: "GET",
    url: "/nodes/node-audit/audit?eventType=heartbeat_received&limit=10",
    headers: { "x-admin-key": "node-audit-key" }
  });
  assert.equal(heartbeatOnly.statusCode, 200);
  assert.equal(heartbeatOnly.json().items.length, 1);
  assert.equal(heartbeatOnly.json().items[0].eventType, "heartbeat_received");

  const invalidType = await app.inject({
    method: "GET",
    url: "/nodes/node-audit/audit?eventType=bad_type",
    headers: { "x-admin-key": "node-audit-key" }
  });
  assert.equal(invalidType.statusCode, 400);
});

test("task can be created, claimed and completed", async (t) => {
  const app = buildApp({ adminApiKey: "ops-key" });
  t.after(() => app.close());

  const unauthorizedCreate = await app.inject({
    method: "POST",
    url: "/tasks",
    payload: {
      kind: "molecule_score",
      payload: { smiles: "CCO" },
      quorum: 1
    }
  });
  assert.equal(unauthorizedCreate.statusCode, 401);

  const created = await app.inject({
    method: "POST",
    url: "/tasks",
    headers: { "x-admin-key": "ops-key" },
    payload: {
      kind: "molecule_score",
      payload: { smiles: "CCO" },
      quorum: 1
    }
  });

  assert.equal(created.statusCode, 201);
  const task = created.json();

  const claim = await app.inject({ method: "GET", url: "/tasks/claim?nodeId=node-a" });
  assert.equal(claim.statusCode, 200);
  assert.equal(claim.json().id, task.id);

  const result = await app.inject({
    method: "POST",
    url: `/tasks/${task.id}/result`,
    payload: {
      nodeId: "node-a",
      checksum: "abc123",
      score: 0.77,
      payload: { score: 0.77 }
    }
  });

  assert.equal(result.statusCode, 202);
  assert.equal(result.json().accepted, true);

  const telemetry = await app.inject({ method: "GET", url: "/telemetry" });
  assert.equal(telemetry.statusCode, 200);
  assert.equal(telemetry.json().queue.completed, 1);
});

test("POST /tasks/:id/cancel cancels pending task and blocks further claims", async (t) => {
  const app = buildApp({ adminApiKey: "ops-key" });
  t.after(() => app.close());

  const created = await app.inject({
    method: "POST",
    url: "/tasks",
    headers: { "x-admin-key": "ops-key" },
    payload: {
      kind: "bio_prescreen",
      payload: { sample: "cancel-1" },
      quorum: 1
    }
  });
  assert.equal(created.statusCode, 201);
  const task = created.json();

  const unauthorized = await app.inject({ method: "POST", url: `/tasks/${task.id}/cancel` });
  assert.equal(unauthorized.statusCode, 401);

  const canceled = await app.inject({
    method: "POST",
    url: `/tasks/${task.id}/cancel`,
    headers: { "x-admin-key": "ops-key" }
  });
  assert.equal(canceled.statusCode, 200);
  assert.equal(canceled.json().canceled, true);

  const claim = await app.inject({ method: "GET", url: "/tasks/claim?nodeId=node-after-cancel" });
  assert.equal(claim.statusCode, 204);

  const snapshot = await app.inject({ method: "GET", url: `/tasks/${task.id}` });
  assert.equal(snapshot.statusCode, 200);
  assert.equal(snapshot.json().state, "failed");

  const missing = await app.inject({
    method: "POST",
    url: "/tasks/not-found/cancel",
    headers: { "x-admin-key": "ops-key" }
  });
  assert.equal(missing.statusCode, 404);
});

test("canceling completed task returns conflict", async (t) => {
  const app = buildApp({ adminApiKey: "ops-key" });
  t.after(() => app.close());

  const created = await app.inject({
    method: "POST",
    url: "/tasks",
    headers: { "x-admin-key": "ops-key" },
    payload: {
      kind: "molecule_score",
      payload: { smiles: "COC" },
      quorum: 1
    }
  });
  const task = created.json();

  await app.inject({ method: "GET", url: "/tasks/claim?nodeId=node-cancel-conflict" });
  await app.inject({
    method: "POST",
    url: `/tasks/${task.id}/result`,
    payload: {
      nodeId: "node-cancel-conflict",
      checksum: "done",
      score: 0.9,
      payload: {}
    }
  });

  const canceled = await app.inject({
    method: "POST",
    url: `/tasks/${task.id}/cancel`,
    headers: { "x-admin-key": "ops-key" }
  });
  assert.equal(canceled.statusCode, 409);
  assert.equal(canceled.json().reason, "task_already_completed");
});

test("POST /tasks/:id/requeue reactivates failed task", async (t) => {
  let now = 1_000;
  configureStoreRuntime({ leaseTtlMs: 100, maxAttempts: 1, nowProvider: () => now });
  const app = buildApp({ adminApiKey: "ops-key" });
  t.after(() => app.close());

  const created = await app.inject({
    method: "POST",
    url: "/tasks",
    headers: { "x-admin-key": "ops-key" },
    payload: {
      kind: "bio_prescreen",
      payload: { sample: "requeue-1" },
      quorum: 1
    }
  });
  const task = created.json();

  const claimed = await app.inject({ method: "GET", url: "/tasks/claim?nodeId=node-requeue-1" });
  assert.equal(claimed.statusCode, 200);

  now += 101;
  const noTask = await app.inject({ method: "GET", url: "/tasks/claim?nodeId=node-requeue-2" });
  assert.equal(noTask.statusCode, 204);

  const failedSnapshot = await app.inject({ method: "GET", url: `/tasks/${task.id}` });
  assert.equal(failedSnapshot.statusCode, 200);
  assert.equal(failedSnapshot.json().state, "failed");

  const unauthorized = await app.inject({ method: "POST", url: `/tasks/${task.id}/requeue` });
  assert.equal(unauthorized.statusCode, 401);

  const requeued = await app.inject({
    method: "POST",
    url: `/tasks/${task.id}/requeue`,
    headers: { "x-admin-key": "ops-key" }
  });
  assert.equal(requeued.statusCode, 200);
  assert.equal(requeued.json().requeued, true);

  const pendingSnapshot = await app.inject({ method: "GET", url: `/tasks/${task.id}` });
  assert.equal(pendingSnapshot.statusCode, 200);
  assert.equal(pendingSnapshot.json().state, "pending");
  assert.equal(pendingSnapshot.json().attempts, 0);
  assert.equal(pendingSnapshot.json().resultCount, 0);

  const reclaimed = await app.inject({ method: "GET", url: "/tasks/claim?nodeId=node-requeue-3" });
  assert.equal(reclaimed.statusCode, 200);
  assert.equal(reclaimed.json().id, task.id);

  const badState = await app.inject({
    method: "POST",
    url: `/tasks/${task.id}/requeue`,
    headers: { "x-admin-key": "ops-key" }
  });
  assert.equal(badState.statusCode, 409);
  assert.equal(badState.json().reason, "task_not_failed");

  const missing = await app.inject({
    method: "POST",
    url: "/tasks/not-found/requeue",
    headers: { "x-admin-key": "ops-key" }
  });
  assert.equal(missing.statusCode, 404);
});

test("DELETE /tasks/:id removes task from queue", async (t) => {
  const app = buildApp({ adminApiKey: "ops-key" });
  t.after(() => app.close());

  const created = await app.inject({
    method: "POST",
    url: "/tasks",
    headers: { "x-admin-key": "ops-key" },
    payload: {
      kind: "bio_prescreen",
      payload: { sample: "delete-1" },
      quorum: 1
    }
  });
  assert.equal(created.statusCode, 201);
  const task = created.json();

  const unauthorized = await app.inject({ method: "DELETE", url: `/tasks/${task.id}` });
  assert.equal(unauthorized.statusCode, 401);

  const deleted = await app.inject({
    method: "DELETE",
    url: `/tasks/${task.id}`,
    headers: { "x-admin-key": "ops-key" }
  });
  assert.equal(deleted.statusCode, 200);
  assert.equal(deleted.json().deleted, true);

  const missingSnapshot = await app.inject({ method: "GET", url: `/tasks/${task.id}` });
  assert.equal(missingSnapshot.statusCode, 404);

  const claim = await app.inject({ method: "GET", url: "/tasks/claim?nodeId=node-after-delete" });
  assert.equal(claim.statusCode, 204);

  const missing = await app.inject({
    method: "DELETE",
    url: `/tasks/${task.id}`,
    headers: { "x-admin-key": "ops-key" }
  });
  assert.equal(missing.statusCode, 404);
});

test("GET /tasks lists and filters by state", async (t) => {
  const app = buildApp({ adminApiKey: "ops-key" });
  t.after(() => app.close());

  const completedCreated = await app.inject({
    method: "POST",
    url: "/tasks",
    headers: { "x-admin-key": "ops-key" },
    payload: {
      kind: "molecule_score",
      payload: { smiles: "CCO" },
      quorum: 1
    }
  });
  assert.equal(completedCreated.statusCode, 201);
  const completedTask = completedCreated.json();

  const claim = await app.inject({ method: "GET", url: "/tasks/claim?nodeId=node-list" });
  assert.equal(claim.statusCode, 200);

  const submit = await app.inject({
    method: "POST",
    url: `/tasks/${completedTask.id}/result`,
    payload: {
      nodeId: "node-list",
      checksum: "list-ok",
      score: 0.71,
      payload: {}
    }
  });
  assert.equal(submit.statusCode, 202);

  const pendingCreated = await app.inject({
    method: "POST",
    url: "/tasks",
    headers: { "x-admin-key": "ops-key" },
    payload: {
      kind: "molecule_score",
      payload: { smiles: "CCC" },
      quorum: 1
    }
  });
  assert.equal(pendingCreated.statusCode, 201);

  const all = await app.inject({ method: "GET", url: "/tasks?limit=10" });
  assert.equal(all.statusCode, 200);
  assert.equal(all.json().items.length, 2);

  const completedOnly = await app.inject({ method: "GET", url: "/tasks?state=completed&limit=10" });
  assert.equal(completedOnly.statusCode, 200);
  assert.equal(completedOnly.json().items.length, 1);
  assert.equal(completedOnly.json().items[0].state, "completed");

  const pendingOnly = await app.inject({ method: "GET", url: "/tasks?state=pending&limit=10" });
  assert.equal(pendingOnly.statusCode, 200);
  assert.equal(pendingOnly.json().items.length, 1);
  assert.equal(pendingOnly.json().items[0].state, "pending");

  const invalidState = await app.inject({ method: "GET", url: "/tasks?state=unknown" });
  assert.equal(invalidState.statusCode, 400);

  const invalidLimit = await app.inject({ method: "GET", url: "/tasks?limit=0" });
  assert.equal(invalidLimit.statusCode, 400);
});

test("GET /tasks/:id returns lifecycle snapshot", async (t) => {
  const app = buildApp({ adminApiKey: "ops-key" });
  t.after(() => app.close());

  const created = await app.inject({
    method: "POST",
    url: "/tasks",
    headers: { "x-admin-key": "ops-key" },
    payload: {
      kind: "molecule_score",
      payload: { smiles: "CCN" },
      quorum: 1
    }
  });

  assert.equal(created.statusCode, 201);
  const task = created.json();

  const pending = await app.inject({ method: "GET", url: `/tasks/${task.id}` });
  assert.equal(pending.statusCode, 200);
  assert.equal(pending.json().state, "pending");
  assert.equal(pending.json().attempts, 0);

  const claimed = await app.inject({ method: "GET", url: "/tasks/claim?nodeId=node-snap" });
  assert.equal(claimed.statusCode, 200);

  const leased = await app.inject({ method: "GET", url: `/tasks/${task.id}` });
  assert.equal(leased.statusCode, 200);
  assert.equal(leased.json().state, "leased");
  assert.equal(leased.json().leaseOwner, "node-snap");

  const result = await app.inject({
    method: "POST",
    url: `/tasks/${task.id}/result`,
    payload: {
      nodeId: "node-snap",
      checksum: "snap-ok",
      score: 0.92,
      payload: {}
    }
  });
  assert.equal(result.statusCode, 202);

  const completed = await app.inject({ method: "GET", url: `/tasks/${task.id}` });
  assert.equal(completed.statusCode, 200);
  assert.equal(completed.json().state, "completed");
  assert.equal(completed.json().resultCount, 1);

  const missing = await app.inject({ method: "GET", url: "/tasks/not-found" });
  assert.equal(missing.statusCode, 404);
});

test("GET /tasks/:id/results returns submitted results", async (t) => {
  const app = buildApp({ adminApiKey: "ops-key" });
  t.after(() => app.close());

  const created = await app.inject({
    method: "POST",
    url: "/tasks",
    headers: { "x-admin-key": "ops-key" },
    payload: {
      kind: "molecule_score",
      payload: { smiles: "CCCl" },
      quorum: 2
    }
  });
  assert.equal(created.statusCode, 201);
  const task = created.json();

  await app.inject({ method: "GET", url: "/tasks/claim?nodeId=node-rs-1" });
  const first = await app.inject({
    method: "POST",
    url: `/tasks/${task.id}/result`,
    payload: {
      nodeId: "node-rs-1",
      checksum: "rs-1",
      score: 0.61,
      payload: { tag: "first" }
    }
  });
  assert.equal(first.statusCode, 202);

  await app.inject({ method: "GET", url: "/tasks/claim?nodeId=node-rs-2" });
  const second = await app.inject({
    method: "POST",
    url: `/tasks/${task.id}/result`,
    payload: {
      nodeId: "node-rs-2",
      checksum: "rs-2",
      score: 0.73,
      payload: { tag: "second" }
    }
  });
  assert.equal(second.statusCode, 202);

  const listed = await app.inject({ method: "GET", url: `/tasks/${task.id}/results?limit=10` });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json().items.length, 2);
  assert.equal(listed.json().items[0].nodeId, "node-rs-2");

  const bounded = await app.inject({ method: "GET", url: `/tasks/${task.id}/results?limit=1` });
  assert.equal(bounded.statusCode, 200);
  assert.equal(bounded.json().items.length, 1);
  assert.equal(bounded.json().items[0].nodeId, "node-rs-2");

  const missing = await app.inject({ method: "GET", url: "/tasks/not-found/results" });
  assert.equal(missing.statusCode, 404);

  const invalidLimit = await app.inject({ method: "GET", url: `/tasks/${task.id}/results?limit=0` });
  assert.equal(invalidLimit.statusCode, 400);
});

test("GET /tasks/:id/verdicts returns task-specific verdict history", async (t) => {
  const app = buildApp({ adminApiKey: "ops-key" });
  t.after(() => app.close());

  const created = await app.inject({
    method: "POST",
    url: "/tasks",
    headers: { "x-admin-key": "ops-key" },
    payload: {
      kind: "molecule_score",
      payload: { smiles: "CNO" },
      quorum: 2
    }
  });
  const task = created.json();

  await app.inject({ method: "GET", url: "/tasks/claim?nodeId=node-v-1" });
  await app.inject({
    method: "POST",
    url: `/tasks/${task.id}/result`,
    payload: {
      nodeId: "node-v-1",
      checksum: "v-ok",
      score: 0.64,
      payload: {}
    }
  });

  await app.inject({
    method: "POST",
    url: `/tasks/${task.id}/result`,
    payload: {
      nodeId: "node-v-1",
      checksum: "v-dup",
      score: 0.61,
      payload: {}
    }
  });

  const verdicts = await app.inject({ method: "GET", url: `/tasks/${task.id}/verdicts?limit=10` });
  assert.equal(verdicts.statusCode, 200);
  assert.equal(verdicts.json().items.length, 2);
  assert.equal(verdicts.json().items[0].accepted, false);
  assert.equal(verdicts.json().items[1].accepted, true);

  const bounded = await app.inject({ method: "GET", url: `/tasks/${task.id}/verdicts?limit=1` });
  assert.equal(bounded.statusCode, 200);
  assert.equal(bounded.json().items.length, 1);

  const missing = await app.inject({ method: "GET", url: "/tasks/not-found/verdicts" });
  assert.equal(missing.statusCode, 404);

  const invalidLimit = await app.inject({ method: "GET", url: `/tasks/${task.id}/verdicts?limit=0` });
  assert.equal(invalidLimit.statusCode, 400);
});

test("GET /tasks/:id/audit returns task-specific audit history", async (t) => {
  let now = 30_000;
  const app = buildApp({ adminApiKey: "audit-task-key", nowProvider: () => now });
  t.after(() => app.close());

  const created = await app.inject({
    method: "POST",
    url: "/tasks",
    headers: { "x-admin-key": "audit-task-key" },
    payload: {
      kind: "bio_prescreen",
      payload: { sample: "task-audit" },
      quorum: 1
    }
  });
  assert.equal(created.statusCode, 201);
  const task = created.json();

  now += 1;
  await app.inject({ method: "GET", url: "/tasks/claim?nodeId=node-task-audit" });

  now += 1;
  await app.inject({
    method: "POST",
    url: `/tasks/${task.id}/result`,
    payload: {
      nodeId: "node-task-audit",
      checksum: "task-audit-ok",
      score: 0.88,
      payload: {}
    }
  });

  const unauthorized = await app.inject({ method: "GET", url: `/tasks/${task.id}/audit` });
  assert.equal(unauthorized.statusCode, 401);

  const all = await app.inject({
    method: "GET",
    url: `/tasks/${task.id}/audit?limit=10`,
    headers: { "x-admin-key": "audit-task-key" }
  });
  assert.equal(all.statusCode, 200);
  assert.ok(all.json().items.length >= 3);
  assert.ok(all.json().items.every((item: { taskId?: string }) => item.taskId === task.id));

  const submittedOnly = await app.inject({
    method: "GET",
    url: `/tasks/${task.id}/audit?eventType=result_submitted&limit=10`,
    headers: { "x-admin-key": "audit-task-key" }
  });
  assert.equal(submittedOnly.statusCode, 200);
  assert.equal(submittedOnly.json().items.length, 1);
  assert.equal(submittedOnly.json().items[0].eventType, "result_submitted");

  const missing = await app.inject({
    method: "GET",
    url: "/tasks/not-found/audit",
    headers: { "x-admin-key": "audit-task-key" }
  });
  assert.equal(missing.statusCode, 404);

  const invalidType = await app.inject({
    method: "GET",
    url: `/tasks/${task.id}/audit?eventType=bad_type`,
    headers: { "x-admin-key": "audit-task-key" }
  });
  assert.equal(invalidType.statusCode, 400);
});

test("expired lease allows another node to claim same task", async (t) => {
  let now = 1_000;
  configureStoreRuntime({
    leaseTtlMs: 100,
    maxAttempts: 3,
    nowProvider: () => now
  });

  const app = buildApp({ adminApiKey: "ops-key" });
  t.after(() => app.close());

  const created = await app.inject({
    method: "POST",
    url: "/tasks",
    headers: { "x-admin-key": "ops-key" },
    payload: {
      kind: "bio_prescreen",
      payload: { sample: "case-01" },
      quorum: 1
    }
  });

  const task = created.json();
  const firstClaim = await app.inject({ method: "GET", url: "/tasks/claim?nodeId=node-a" });
  assert.equal(firstClaim.statusCode, 200);
  assert.equal(firstClaim.json().id, task.id);

  now += 101;
  const secondClaim = await app.inject({ method: "GET", url: "/tasks/claim?nodeId=node-b" });
  assert.equal(secondClaim.statusCode, 200);
  assert.equal(secondClaim.json().id, task.id);

  const telemetry = await app.inject({ method: "GET", url: "/telemetry" });
  assert.equal(telemetry.statusCode, 200);
  assert.equal(telemetry.json().queue.expiredLeases, 1);
  assert.equal(telemetry.json().queue.retries, 1);
});

test("admin verdicts endpoint returns recent verdict entries", async (t) => {
  let now = 1000;
  const app = buildApp({
    adminApiKey: "test-admin-key",
    adminRateLimitMax: 2,
    adminRateLimitWindowMs: 1000,
    nowProvider: () => now
  });
  t.after(() => app.close());

  const created = await app.inject({
    method: "POST",
    url: "/tasks",
    headers: { "x-admin-key": "test-admin-key" },
    payload: {
      kind: "molecule_score",
      payload: { smiles: "CCC" },
      quorum: 2
    }
  });

  const task = created.json();
  await app.inject({ method: "GET", url: "/tasks/claim?nodeId=node-r1" });

  const accepted = await app.inject({
    method: "POST",
    url: `/tasks/${task.id}/result`,
    payload: {
      nodeId: "node-r1",
      checksum: "ok-1",
      score: 0.41,
      payload: {}
    }
  });
  assert.equal(accepted.statusCode, 202);

  const rejected = await app.inject({
    method: "POST",
    url: `/tasks/${task.id}/result`,
    payload: {
      nodeId: "node-r1",
      checksum: "dup-1",
      score: 0.39,
      payload: {}
    }
  });
  assert.equal(rejected.statusCode, 409);

  const verdicts = await app.inject({
    method: "GET",
    url: "/admin/verdicts?limit=2",
    headers: { "x-admin-key": "test-admin-key" }
  });
  assert.equal(verdicts.statusCode, 200);
  const items = verdicts.json().items;
  assert.equal(items.length, 2);
  assert.equal(items[0].accepted, false);
  assert.equal(items[1].accepted, true);

  now += 1001;
  const acceptedOnly = await app.inject({
    method: "GET",
    url: "/admin/verdicts?accepted=true&limit=10",
    headers: { "x-admin-key": "test-admin-key" }
  });
  assert.equal(acceptedOnly.statusCode, 200);
  assert.equal(acceptedOnly.json().items.length, 1);
  assert.equal(acceptedOnly.json().items[0].accepted, true);

  now += 1001;
  const byTask = await app.inject({
    method: "GET",
    url: `/admin/verdicts?taskId=${task.id}&limit=10`,
    headers: { "x-admin-key": "test-admin-key" }
  });
  assert.equal(byTask.statusCode, 200);
  assert.equal(byTask.json().items.length, 2);

  now += 1001;
  const invalidAccepted = await app.inject({
    method: "GET",
    url: "/admin/verdicts?accepted=maybe",
    headers: { "x-admin-key": "test-admin-key" }
  });
  assert.equal(invalidAccepted.statusCode, 400);

  now += 1001;
  const unauthorized = await app.inject({ method: "GET", url: "/admin/verdicts?limit=2" });
  assert.equal(unauthorized.statusCode, 401);

  now += 1001;
  const limitedApp = buildApp({
    adminApiKey: "limit-key",
    adminRateLimitMax: 2,
    adminRateLimitWindowMs: 60_000,
    nowProvider: () => 5000
  });
  t.after(() => limitedApp.close());

  const first = await limitedApp.inject({
    method: "GET",
    url: "/admin/verdicts",
    headers: { "x-admin-key": "limit-key", "x-forwarded-for": "10.1.1.10" }
  });
  assert.equal(first.statusCode, 200);

  const second = await limitedApp.inject({
    method: "GET",
    url: "/admin/verdicts",
    headers: { "x-admin-key": "limit-key", "x-forwarded-for": "10.1.1.10" }
  });
  assert.equal(second.statusCode, 200);

  const third = await limitedApp.inject({
    method: "GET",
    url: "/admin/verdicts",
    headers: { "x-admin-key": "limit-key", "x-forwarded-for": "10.1.1.10" }
  });
  assert.equal(third.statusCode, 429);
});

test("admin audit endpoint supports filters and validation", async (t) => {
  let now = 20_000;
  const app = buildApp({
    adminApiKey: "audit-key",
    adminRateLimitMax: 50,
    adminRateLimitWindowMs: 60_000,
    nowProvider: () => now
  });
  t.after(() => app.close());

  const created = await app.inject({
    method: "POST",
    url: "/tasks",
    headers: { "x-admin-key": "audit-key" },
    payload: { kind: "bio_prescreen", payload: { sample: "audit" }, quorum: 1 }
  });
  const task = created.json();

  await app.inject({
    method: "POST",
    url: "/nodes/node-audit/heartbeat",
    payload: { capabilities: { charging: true, wifi: true, idle: true, userOptIn: true } }
  });

  now += 1;
  await app.inject({ method: "GET", url: "/tasks/claim?nodeId=node-audit" });

  now += 1;
  await app.inject({
    method: "POST",
    url: `/tasks/${task.id}/result`,
    payload: { nodeId: "node-audit", checksum: "audit-ok", score: 0.66, payload: {} }
  });

  const byNode = await app.inject({
    method: "GET",
    url: "/admin/audit?nodeId=node-audit&limit=20",
    headers: { "x-admin-key": "audit-key" }
  });
  assert.equal(byNode.statusCode, 200);
  assert.ok(byNode.json().items.length >= 2);

  const byType = await app.inject({
    method: "GET",
    url: "/admin/audit?eventType=result_submitted",
    headers: { "x-admin-key": "audit-key" }
  });
  assert.equal(byType.statusCode, 200);
  assert.ok(byType.json().items.some((item: { eventType: string }) => item.eventType === "result_submitted"));

  const cancelTask = await app.inject({
    method: "POST",
    url: "/tasks",
    headers: { "x-admin-key": "audit-key" },
    payload: { kind: "bio_prescreen", payload: { sample: "cancel-audit" }, quorum: 1 }
  });
  const cancelTaskId = cancelTask.json().id;
  await app.inject({ method: "POST", url: `/tasks/${cancelTaskId}/cancel`, headers: { "x-admin-key": "audit-key" } });

  const canceledEvents = await app.inject({
    method: "GET",
    url: "/admin/audit?eventType=task_canceled",
    headers: { "x-admin-key": "audit-key" }
  });
  assert.equal(canceledEvents.statusCode, 200);
  assert.ok(canceledEvents.json().items.some((item: { eventType: string }) => item.eventType === "task_canceled"));

  await app.inject({ method: "POST", url: `/tasks/${cancelTaskId}/requeue`, headers: { "x-admin-key": "audit-key" } });
  const requeuedEvents = await app.inject({
    method: "GET",
    url: "/admin/audit?eventType=task_requeued",
    headers: { "x-admin-key": "audit-key" }
  });
  assert.equal(requeuedEvents.statusCode, 200);
  assert.ok(requeuedEvents.json().items.some((item: { eventType: string }) => item.eventType === "task_requeued"));

  const deleteTask = await app.inject({
    method: "POST",
    url: "/tasks",
    headers: { "x-admin-key": "audit-key" },
    payload: { kind: "bio_prescreen", payload: { sample: "delete-audit" }, quorum: 1 }
  });
  const deleteTaskId = deleteTask.json().id;
  await app.inject({ method: "DELETE", url: `/tasks/${deleteTaskId}`, headers: { "x-admin-key": "audit-key" } });

  const deletedEvents = await app.inject({
    method: "GET",
    url: "/admin/audit?eventType=task_deleted",
    headers: { "x-admin-key": "audit-key" }
  });
  assert.equal(deletedEvents.statusCode, 200);
  assert.ok(deletedEvents.json().items.some((item: { eventType: string }) => item.eventType === "task_deleted"));

  const invalidType = await app.inject({
    method: "GET",
    url: "/admin/audit?eventType=bad_type",
    headers: { "x-admin-key": "audit-key" }
  });
  assert.equal(invalidType.statusCode, 400);

  const unauthorized = await app.inject({ method: "GET", url: "/admin/audit" });
  assert.equal(unauthorized.statusCode, 401);

  const exportJsonl = await app.inject({
    method: "GET",
    url: "/admin/audit/export?format=jsonl&limit=10",
    headers: { "x-admin-key": "audit-key" }
  });
  assert.equal(exportJsonl.statusCode, 200);
  assert.match(exportJsonl.headers["content-type"] ?? "", /application\/x-ndjson/);
  assert.ok(exportJsonl.body.includes("eventType"));

  const exportCsv = await app.inject({
    method: "GET",
    url: "/admin/audit/export?format=csv&limit=10",
    headers: { "x-admin-key": "audit-key" }
  });
  assert.equal(exportCsv.statusCode, 200);
  assert.match(exportCsv.headers["content-type"] ?? "", /text\/csv/);
  assert.ok(exportCsv.body.startsWith("at,eventType,taskId,nodeId,details"));

  const invalidFormat = await app.inject({
    method: "GET",
    url: "/admin/audit/export?format=xml",
    headers: { "x-admin-key": "audit-key" }
  });
  assert.equal(invalidFormat.statusCode, 400);
});

test("admin status endpoint returns audit persistence status", async (t) => {
  let now = 50_000;
  configureStoreRuntime({ nowProvider: () => now });
  const app = buildApp({
    adminApiKey: "status-key",
    adminRateLimitMax: 10,
    adminRateLimitWindowMs: 60_000,
    nowProvider: () => now
  });
  t.after(() => app.close());

  const created = await app.inject({
    method: "POST",
    url: "/tasks",
    headers: { "x-admin-key": "status-key" },
    payload: { kind: "bio_prescreen", payload: { sample: "status" }, quorum: 1 }
  });
  const task = created.json();

  await app.inject({
    method: "POST",
    url: "/nodes/status-node/heartbeat",
    payload: { capabilities: { charging: true, wifi: true, idle: true, userOptIn: true } }
  });

  await app.inject({ method: "GET", url: "/tasks/claim?nodeId=status-node" });
  await app.inject({
    method: "POST",
    url: `/tasks/${task.id}/result`,
    payload: { nodeId: "status-node", checksum: "status-ok", score: 0.55, payload: {} }
  });

  const unauthorized = await app.inject({ method: "GET", url: "/admin/status" });
  assert.equal(unauthorized.statusCode, 401);

  const authorized = await app.inject({
    method: "GET",
    url: "/admin/status",
    headers: { "x-admin-key": "status-key" }
  });
  assert.equal(authorized.statusCode, 200);
  assert.equal(typeof authorized.json().tasks.total, "number");
  assert.equal(authorized.json().tasks.completed, 1);
  assert.equal(typeof authorized.json().nodes.total, "number");
  assert.equal(authorized.json().nodes.active, 1);
  assert.equal(typeof authorized.json().nodes.enabled, "number");
  assert.equal(typeof authorized.json().nodes.disabled, "number");
  assert.equal(typeof authorized.json().nodes.quarantined, "number");
  assert.ok(Array.isArray(authorized.json().recentVerdicts));
  assert.ok(authorized.json().recentVerdicts.length >= 1);
  assert.ok(Array.isArray(authorized.json().recentAudit));
  assert.ok(authorized.json().recentAudit.length >= 1);
  assert.equal(typeof authorized.json().auditPersistence.enabled, "boolean");
  assert.equal(typeof authorized.json().auditPersistence.maxBytes, "number");
});

test("admin dashboard endpoint returns attention queues for operators", async (t) => {
  let now = 80_000;
  configureStoreRuntime({ leaseTtlMs: 120_000, nowProvider: () => now });
  const app = buildApp({ adminApiKey: "dashboard-key", nowProvider: () => now });
  t.after(() => app.close());

  await app.inject({
    method: "POST",
    url: "/nodes/node-inactive/heartbeat",
    payload: { capabilities: { charging: true, wifi: true, idle: true, userOptIn: true } }
  });

  await app.inject({
    method: "POST",
    url: "/nodes/node-disabled/heartbeat",
    payload: { capabilities: { charging: true, wifi: true, idle: true, userOptIn: true } }
  });
  await app.inject({
    method: "POST",
    url: "/nodes/node-leased/heartbeat",
    payload: { capabilities: { charging: true, wifi: true, idle: true, userOptIn: true } }
  });
  await app.inject({
    method: "POST",
    url: "/nodes/node-disabled/disable",
    headers: { "x-admin-key": "dashboard-key" },
    payload: { reason: "manual_hold" }
  });

  const leasedCreated = await app.inject({
    method: "POST",
    url: "/tasks",
    headers: { "x-admin-key": "dashboard-key" },
    payload: { kind: "bio_prescreen", payload: { sample: "leased" }, quorum: 1 }
  });
  const leasedTask = leasedCreated.json();
  await app.inject({ method: "GET", url: "/tasks/claim?nodeId=node-leased" });

  const failedCreated = await app.inject({
    method: "POST",
    url: "/tasks",
    headers: { "x-admin-key": "dashboard-key" },
    payload: { kind: "bio_prescreen", payload: { sample: "failed" }, quorum: 1 }
  });
  const failedTask = failedCreated.json();
  await app.inject({
    method: "POST",
    url: `/tasks/${failedTask.id}/cancel`,
    headers: { "x-admin-key": "dashboard-key" }
  });

  now += 61_000;

  const unauthorized = await app.inject({ method: "GET", url: "/admin/dashboard" });
  assert.equal(unauthorized.statusCode, 401);

  const authorized = await app.inject({
    method: "GET",
    url: "/admin/dashboard",
    headers: { "x-admin-key": "dashboard-key" }
  });

  assert.equal(authorized.statusCode, 200);
  assert.equal(typeof authorized.json().generatedAt, "string");
  assert.equal(typeof authorized.json().tasks.total, "number");
  assert.equal(typeof authorized.json().nodes.total, "number");
  assert.ok(Array.isArray(authorized.json().attentionTasks));
  assert.ok(Array.isArray(authorized.json().attentionNodes));
  assert.ok(authorized.json().attentionTasks.some((item: { reason: string; snapshot: { task: { id: string } } }) => item.reason === "failed" && item.snapshot.task.id === failedTask.id));
  assert.ok(authorized.json().attentionTasks.some((item: { reason: string; snapshot: { task: { id: string } } }) => item.reason === "leased" && item.snapshot.task.id === leasedTask.id));
  assert.ok(authorized.json().attentionNodes.some((item: { reason: string; snapshot: { stats: { nodeId: string } } }) => item.reason === "disabled" && item.snapshot.stats.nodeId === "node-disabled"));
  assert.ok(authorized.json().attentionNodes.some((item: { reason: string; snapshot: { stats: { nodeId: string } } }) => item.reason === "inactive" && item.snapshot.stats.nodeId === "node-inactive"));
  const leasedAttention = authorized.json().attentionTasks.find((item: { reason: string; snapshot: { task: { id: string } }; details: { ageMs: number; attempts: number; resultCount: number; leaseAgeMs: number | null } }) => item.reason === "leased" && item.snapshot.task.id === leasedTask.id);
  assert.equal(typeof leasedAttention.details.ageMs, "number");
  assert.equal(typeof leasedAttention.details.attempts, "number");
  assert.equal(typeof leasedAttention.details.resultCount, "number");
  assert.equal(typeof leasedAttention.details.leaseAgeMs, "number");
  const disabledAttention = authorized.json().attentionNodes.find((item: { reason: string; snapshot: { stats: { nodeId: string } }; details: { accepted: number; rejected: number; rejectionRate: number; lastSeenAgeMs: number | null; controlAgeMs: number | null } }) => item.reason === "disabled" && item.snapshot.stats.nodeId === "node-disabled");
  assert.equal(typeof disabledAttention.details.accepted, "number");
  assert.equal(typeof disabledAttention.details.rejected, "number");
  assert.equal(typeof disabledAttention.details.rejectionRate, "number");
  assert.equal(typeof disabledAttention.details.lastSeenAgeMs, "number");
  assert.equal(typeof disabledAttention.details.controlAgeMs, "number");
  assert.ok(Array.isArray(authorized.json().recentVerdicts));
  assert.ok(Array.isArray(authorized.json().recentAudit));
  assert.equal(typeof authorized.json().auditPersistence.enabled, "boolean");
});

test("admin dashboard ui endpoint serves html shell", async (t) => {
  const app = buildApp({ adminApiKey: "dashboard-ui-key" });
  t.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/admin/dashboard/ui" });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"] ?? "", /text\/html/);
  assert.match(response.body, /Bio Swarm Operator Console/);
  assert.match(response.body, /\/admin\/dashboard/);
  assert.match(response.body, /id="language"/);
  assert.match(response.body, /id="gpuNodes"/);
  assert.match(response.body, /id="gpuActiveOnly"/);
  assert.match(response.body, /id="gpuMinVram"/);
  assert.match(response.body, />EN<\/option>/);
  assert.match(response.body, /bioSwarmLanguage/);
});

test("package registry API creates, lists and fetches packages", async (t) => {
  const app = buildApp({ adminApiKey: "package-key" });
  t.after(() => app.close());

  const unauthorized = await app.inject({
    method: "POST",
    url: "/packages",
    payload: {
      name: "sim-kernel",
      version: "1.0.0",
      runtime: "node",
      entrypoint: "index.js",
      content: "export function run(input){ return { ok: true, input }; }"
    }
  });
  assert.equal(unauthorized.statusCode, 401);

  const created = await app.inject({
    method: "POST",
    url: "/packages",
    headers: { "x-admin-key": "package-key" },
    payload: {
      name: "sim-kernel",
      version: "1.0.0",
      runtime: "node",
      entrypoint: "index.js",
      content: "export function run(input){ return { ok: true, input }; }"
    }
  });
  assert.equal(created.statusCode, 201);
  assert.equal(typeof created.json().packageId, "string");
  assert.equal(typeof created.json().checksum, "string");
  assert.ok(created.json().sizeBytes > 0);

  const listed = await app.inject({
    method: "GET",
    url: "/packages?limit=10",
    headers: { "x-admin-key": "package-key" }
  });
  assert.equal(listed.statusCode, 200);
  assert.ok(Array.isArray(listed.json().items));
  assert.equal(listed.json().items.length, 1);
  assert.equal(listed.json().items[0].packageId, created.json().packageId);

  const fetched = await app.inject({
    method: "GET",
    url: `/packages/${created.json().packageId}`,
    headers: { "x-admin-key": "package-key" }
  });
  assert.equal(fetched.statusCode, 200);
  assert.equal(fetched.json().packageId, created.json().packageId);
  assert.equal(typeof fetched.json().content, "string");

  const resolvedByName = await app.inject({
    method: "GET",
    url: "/packages/resolve?name=sim-kernel",
    headers: { "x-admin-key": "package-key" }
  });
  assert.equal(resolvedByName.statusCode, 200);
  assert.equal(resolvedByName.json().packageId, created.json().packageId);

  const resolvedByVersion = await app.inject({
    method: "GET",
    url: "/packages/resolve?name=sim-kernel&version=1.0.0",
    headers: { "x-admin-key": "package-key" }
  });
  assert.equal(resolvedByVersion.statusCode, 200);
  assert.equal(resolvedByVersion.json().packageId, created.json().packageId);

  const missing = await app.inject({
    method: "GET",
    url: "/packages/missing",
    headers: { "x-admin-key": "package-key" }
  });
  assert.equal(missing.statusCode, 404);

  const missingResolved = await app.inject({
    method: "GET",
    url: "/packages/resolve?name=sim-kernel&version=9.9.9",
    headers: { "x-admin-key": "package-key" }
  });
  assert.equal(missingResolved.statusCode, 404);
});

test("worker registry API registers, heartbeats, lists and fetches workers", async (t) => {
  const app = buildApp({ adminApiKey: "worker-key" });
  t.after(() => app.close());

  const unauthorized = await app.inject({
    method: "POST",
    url: "/workers/register",
    payload: {
      workerId: "worker-1",
      agentVersion: "worker/0.1.0",
      platform: "darwin-arm64"
    }
  });
  assert.equal(unauthorized.statusCode, 401);

  const registered = await app.inject({
    method: "POST",
    url: "/workers/register",
    headers: { "x-admin-key": "worker-key" },
    payload: {
      workerId: "worker-1",
      nodeId: "node-1",
      agentVersion: "worker/0.1.0",
      platform: "darwin-arm64",
      status: "running",
      packageCount: 1
    }
  });
  assert.equal(registered.statusCode, 201);
  assert.equal(registered.json().workerId, "worker-1");

  const heartbeat = await app.inject({
    method: "POST",
    url: "/workers/worker-1/heartbeat",
    headers: { "x-admin-key": "worker-key" },
    payload: {
      status: "idle",
      packageCount: 2,
      lastPackageId: "pkg-1",
      lastPackageVersion: "1.1.0",
      lastPackageChecksum: "abc123",
      lastTaskId: "task-42",
      lastTaskKind: "package_execute",
      lastExecutionStatus: "completed",
      lastExecutionError: ""
    }
  });
  assert.equal(heartbeat.statusCode, 200);
  assert.equal(heartbeat.json().status, "idle");
  assert.equal(heartbeat.json().packageCount, 2);
  assert.equal(heartbeat.json().lastPackageVersion, "1.1.0");
  assert.equal(heartbeat.json().lastTaskId, "task-42");
  assert.equal(heartbeat.json().lastTaskKind, "package_execute");
  assert.equal(heartbeat.json().lastExecutionStatus, "completed");
  assert.equal(heartbeat.json().lastExecutionError, null);

  const listed = await app.inject({
    method: "GET",
    url: "/workers?limit=10",
    headers: { "x-admin-key": "worker-key" }
  });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json().items.length, 1);
  assert.equal(listed.json().items[0].workerId, "worker-1");

  const fetched = await app.inject({
    method: "GET",
    url: "/workers/worker-1",
    headers: { "x-admin-key": "worker-key" }
  });
  assert.equal(fetched.statusCode, 200);
  assert.equal(fetched.json().workerId, "worker-1");
  assert.equal(fetched.json().status, "idle");
  assert.equal(fetched.json().lastTaskId, "task-42");

  const missing = await app.inject({
    method: "GET",
    url: "/workers/missing",
    headers: { "x-admin-key": "worker-key" }
  });
  assert.equal(missing.statusCode, 404);
});

test("research experiments API creates, lists and reads details", async (t) => {
  const app = buildApp({ adminApiKey: "research-key" });
  t.after(() => app.close());

  const unauthorized = await app.inject({
    method: "POST",
    url: "/research/experiments",
    payload: {
      name: "Unauthorized",
      modelVersion: "bio-llm-v1",
      steps: 100,
      quorum: 1,
      prompt: "test"
    }
  });
  assert.equal(unauthorized.statusCode, 401);

  const invalid = await app.inject({
    method: "POST",
    url: "/research/experiments",
    headers: { "x-admin-key": "research-key" },
    payload: {
      name: "",
      modelVersion: "bio-llm-v1",
      steps: 5,
      quorum: 0,
      prompt: ""
    }
  });
  assert.equal(invalid.statusCode, 400);

  const created = await app.inject({
    method: "POST",
    url: "/research/experiments",
    headers: { "x-admin-key": "research-key" },
    payload: {
      name: "Mutation Sweep A",
      modelVersion: "bio-llm-v1",
      steps: 1200,
      quorum: 1,
      mutationRate: 0.02,
      populationSize: 1024,
      prompt: "Find stable mutation regimes"
    }
  });
  assert.equal(created.statusCode, 201);
  assert.equal(typeof created.json().experimentId, "string");
  assert.equal(typeof created.json().taskId, "string");

  const task = await app.inject({ method: "GET", url: `/tasks/${created.json().taskId}` });
  assert.equal(task.statusCode, 200);
  assert.equal(task.json().task.kind, "bio_simulation");

  const listed = await app.inject({
    method: "GET",
    url: "/research/experiments?limit=10",
    headers: { "x-admin-key": "research-key" }
  });
  assert.equal(listed.statusCode, 200);
  assert.ok(listed.json().items.length >= 1);
  assert.equal(listed.json().items[0].experimentId, created.json().experimentId);
  assert.equal(listed.json().items[0].status, "queued");

  const claimed = await app.inject({ method: "GET", url: "/tasks/claim?nodeId=research-node-1" });
  assert.equal(claimed.statusCode, 200);
  assert.equal(claimed.json().id, created.json().taskId);

  const submitted = await app.inject({
    method: "POST",
    url: `/tasks/${created.json().taskId}/result`,
    payload: {
      nodeId: "research-node-1",
      checksum: "research-ok-1",
      score: 0.83,
      payload: { score: 0.83, metrics: { convergence: 0.81 } }
    }
  });
  assert.equal(submitted.statusCode, 202);

  const details = await app.inject({
    method: "GET",
    url: `/research/experiments/${created.json().experimentId}`,
    headers: { "x-admin-key": "research-key" }
  });
  assert.equal(details.statusCode, 200);
  assert.equal(details.json().status, "completed");
  assert.equal(details.json().resultCount, 1);
  assert.equal(details.json().bestScore, 0.83);
  assert.equal(details.json().results.length, 1);

  const missing = await app.inject({
    method: "GET",
    url: "/research/experiments/not-found",
    headers: { "x-admin-key": "research-key" }
  });
  assert.equal(missing.statusCode, 404);
});
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
  const app = buildApp({ nowProvider: () => now });
  t.after(() => app.close());

  const hb1 = await app.inject({ method: "POST", url: "/nodes/node-a/heartbeat", payload: {} });
  assert.equal(hb1.statusCode, 200);

  now += 61_000;
  const hb2 = await app.inject({ method: "POST", url: "/nodes/node-b/heartbeat", payload: {} });
  assert.equal(hb2.statusCode, 200);

  const all = await app.inject({ method: "GET", url: "/nodes?limit=10" });
  assert.equal(all.statusCode, 200);
  assert.equal(all.json().items.length, 2);

  const activeOnly = await app.inject({ method: "GET", url: "/nodes?active=true&limit=10" });
  assert.equal(activeOnly.statusCode, 200);
  assert.equal(activeOnly.json().items.length, 1);
  assert.equal(activeOnly.json().items[0].nodeId, "node-b");

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

  now += 61_000;
  const stale = await app.inject({ method: "GET", url: "/nodes/node-snapshot" });
  assert.equal(stale.statusCode, 200);
  assert.equal(stale.json().active, false);
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
  assert.ok(Array.isArray(authorized.json().recentVerdicts));
  assert.ok(authorized.json().recentVerdicts.length >= 1);
  assert.ok(Array.isArray(authorized.json().recentAudit));
  assert.ok(authorized.json().recentAudit.length >= 1);
  assert.equal(typeof authorized.json().auditPersistence.enabled, "boolean");
  assert.equal(typeof authorized.json().auditPersistence.maxBytes, "number");
});
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

test("task can be created, claimed and completed", async (t) => {
  const app = buildApp();
  t.after(() => app.close());

  const created = await app.inject({
    method: "POST",
    url: "/tasks",
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

test("expired lease allows another node to claim same task", async (t) => {
  let now = 1_000;
  configureStoreRuntime({
    leaseTtlMs: 100,
    maxAttempts: 3,
    nowProvider: () => now
  });

  const app = buildApp();
  t.after(() => app.close());

  const created = await app.inject({
    method: "POST",
    url: "/tasks",
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
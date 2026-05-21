import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import type { SwarmTask } from "@bio-swarm/shared";
import {
  canProcess,
  claimTask,
  processTask,
  registerWorker,
  resetPackageCacheForTests,
  sendHeartbeat,
  sendWorkerHeartbeat,
  submitResult,
  type EdgeRuntimeConfig,
  type EdgeRuntimeDeps
} from "./worker.js";

function createConfig(): EdgeRuntimeConfig {
  return {
    orchestratorUrl: "http://localhost:4000",
    nodeId: "edge-test-node",
    capabilities: {
      charging: true,
      wifi: true,
      idle: true,
      userOptIn: true
    },
    idleSleepMs: 5000,
    claimSleepMs: 1500,
    heartbeatIntervalMs: 10_000
  };
}

function createDeps(fetchFn: typeof fetch): EdgeRuntimeDeps {
  return {
    fetchFn,
    waitFn: async () => {},
    setIntervalFn: setInterval,
    clearIntervalFn: clearInterval,
    log: {
      log: () => {},
      error: () => {}
    }
  };
}

function signPackage(input: {
  name?: string;
  version?: string;
  runtime: string;
  entrypoint: string;
  permissions?: string[];
  checksum: string;
  key: string;
}): string {
  const payload = JSON.stringify({
    name: input.name ?? "",
    version: input.version ?? "",
    runtime: input.runtime,
    entrypoint: input.entrypoint,
    permissions: input.permissions ?? [],
    checksum: input.checksum
  });

  return crypto.createHmac("sha256", input.key).update(payload).digest("hex");
}

function signTaskEnvelope(input: {
  id: string;
  kind: SwarmTask["kind"];
  payload: Record<string, unknown>;
  createdAt: string;
  quorum: number;
  expiresAt: string;
  key: string;
}): string {
  const payload = JSON.stringify({
    id: input.id,
    kind: input.kind,
    payload: input.payload,
    createdAt: input.createdAt,
    quorum: input.quorum,
    expiresAt: input.expiresAt
  });

  return crypto.createHmac("sha256", input.key).update(payload).digest("hex");
}

test("processTask returns deterministic structure", async () => {
  const task: SwarmTask = {
    id: "t-1",
    kind: "molecule_score",
    payload: { smiles: "CCO" },
    createdAt: new Date().toISOString(),
    quorum: 1
  };

  const first = await processTask(task, "node-1");
  const second = await processTask(task, "node-1");

  assert.equal(first.nodeId, "node-1");
  assert.equal(first.score, second.score);
  assert.equal(first.checksum, second.checksum);
});

test("processTask handles llm_inference payload", async () => {
  const task: SwarmTask = {
    id: "t-llm-1",
    kind: "llm_inference",
    payload: {
      prompt: "Summarize distributed biomedical inference in one paragraph.",
      model: "bio-llm-v2",
      maxTokens: 200,
      temperature: 0.2
    },
    createdAt: new Date().toISOString(),
    quorum: 1
  };

  const result = await processTask(task, "node-gpu-1");
  assert.equal(result.nodeId, "node-gpu-1");
  assert.equal(typeof result.payload.completion, "string");
  assert.equal(typeof result.payload.usage, "object");
  assert.equal(typeof result.score, "number");
  assert.ok(result.score >= 0);
  assert.ok(result.score <= 1);
});

test("processTask verifies signed task envelope when taskSigningKey is configured", async () => {
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const payload = { sample: "signed-task" };
  const signature = signTaskEnvelope({
    id: "t-signed-1",
    kind: "bio_prescreen",
    payload,
    createdAt,
    quorum: 1,
    expiresAt,
    key: "task-sign-key"
  });

  const result = await processTask(
    {
      id: "t-signed-1",
      kind: "bio_prescreen",
      payload,
      createdAt,
      quorum: 1,
      expiresAt,
      signature,
      signatureAlgorithm: "hmac-sha256"
    },
    "node-signed-1",
    {
      ...createConfig(),
      taskSigningKey: "task-sign-key"
    }
  );

  assert.equal(result.score > 0, true);
});

test("processTask rejects signed task when signature is invalid", async () => {
  const result = await processTask(
    {
      id: "t-signed-bad-1",
      kind: "bio_prescreen",
      payload: { sample: "signed-task" },
      createdAt: new Date().toISOString(),
      quorum: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      signature: "deadbeef",
      signatureAlgorithm: "hmac-sha256"
    },
    "node-signed-bad-1",
    {
      ...createConfig(),
      taskSigningKey: "task-sign-key"
    }
  );

  assert.equal(result.score, 0);
  assert.equal(result.payload.error, "task_signature_invalid");
});

test("processTask handles package_execute with package download and checksum verification", async () => {
  resetPackageCacheForTests();
  const packageContent = "export function run(input){ return { ok: true, input }; }";
  const checksum = crypto.createHash("sha256").update(packageContent).digest("hex");
  const task: SwarmTask = {
    id: "t-pkg-1",
    kind: "package_execute",
    payload: {
      packageId: "pkg-1",
      checksum,
      input: { sample: "abc" }
    },
    createdAt: new Date().toISOString(),
    quorum: 1
  };

  const deps = createDeps(async (url, init) => {
    if (String(url).includes("/packages/pkg-1")) {
      return new Response(
        JSON.stringify({
          packageId: "pkg-1",
          runtime: "node",
          entrypoint: "index.js",
          checksum,
          content: packageContent
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response("", { status: 404 });
  });

  const result = await processTask(
    task,
    "node-pkg-1",
    {
      ...createConfig(),
      adminApiKey: "edge-package-key"
    },
    deps
  );

  assert.equal(result.nodeId, "node-pkg-1");
  assert.equal(result.payload.packageId, "pkg-1");
  assert.equal(result.payload.checksumVerified, true);
  assert.equal(typeof result.payload.output, "object");
  assert.ok(result.score > 0);
});

test("processTask reuses package cache for repeated package_execute tasks", async () => {
  resetPackageCacheForTests();
  const packageContent = "export function run(input){ return input; }";
  const checksum = crypto.createHash("sha256").update(packageContent).digest("hex");
  let packageFetchCount = 0;

  const deps = createDeps(async (url) => {
    if (String(url).includes("/packages/pkg-cache-1")) {
      packageFetchCount += 1;
      return new Response(
        JSON.stringify({
          packageId: "pkg-cache-1",
          runtime: "node",
          entrypoint: "index.js",
          checksum,
          content: packageContent
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    return new Response("", { status: 404 });
  });

  const task: SwarmTask = {
    id: "t-pkg-cache-1",
    kind: "package_execute",
    payload: {
      packageId: "pkg-cache-1",
      checksum,
      input: { n: 1 }
    },
    createdAt: new Date().toISOString(),
    quorum: 1
  };

  const config = {
    ...createConfig(),
    adminApiKey: "edge-package-key"
  };

  await processTask(task, "node-pkg-1", config, deps);
  await processTask(task, "node-pkg-1", config, deps);
  assert.equal(packageFetchCount, 1);
});

test("processTask resolves package_execute by package name and version", async () => {
  resetPackageCacheForTests();
  const packageContent = "export function run(input){ return input; }";
  const checksum = crypto.createHash("sha256").update(packageContent).digest("hex");

  const deps = createDeps(async (url) => {
    const target = String(url);
    if (target.includes("/packages/resolve?")) {
      return new Response(
        JSON.stringify({
          packageId: "pkg-resolved-1",
          name: "sim-kernel",
          version: "1.1.0",
          runtime: "node",
          entrypoint: "index.js",
          checksum,
          content: packageContent
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    if (target.includes("/packages/pkg-resolved-1")) {
      return new Response(
        JSON.stringify({
          packageId: "pkg-resolved-1",
          runtime: "node",
          entrypoint: "index.js",
          checksum,
          content: packageContent
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    return new Response("", { status: 404 });
  });

  const task: SwarmTask = {
    id: "t-pkg-name-1",
    kind: "package_execute",
    payload: {
      packageName: "sim-kernel",
      packageVersion: "1.1.0",
      input: { n: 1 }
    },
    createdAt: new Date().toISOString(),
    quorum: 1
  };

  const result = await processTask(
    task,
    "node-pkg-1",
    {
      ...createConfig(),
      adminApiKey: "edge-package-key"
    },
    deps
  );

  assert.equal(result.payload.packageId, "pkg-resolved-1");
  assert.equal(result.payload.packageVersion, "1.1.0");
  assert.equal(result.payload.checksumVerified, true);
});

test("processTask verifies package signature with packageSigningKey", async () => {
  resetPackageCacheForTests();
  const packageContent = "export function run(input){ return input; }";
  const checksum = crypto.createHash("sha256").update(packageContent).digest("hex");
  const signingKey = "edge-signing-key";
  const signature = signPackage({
    name: "signed-kernel",
    version: "1.0.0",
    runtime: "node",
    entrypoint: "index.js",
    permissions: [],
    checksum,
    key: signingKey
  });

  const deps = createDeps(async (url) => {
    if (String(url).includes("/packages/pkg-signed-1")) {
      return new Response(
        JSON.stringify({
          packageId: "pkg-signed-1",
          name: "signed-kernel",
          version: "1.0.0",
          runtime: "node",
          entrypoint: "index.js",
          permissions: [],
          checksum,
          signature,
          signatureAlgorithm: "hmac-sha256",
          content: packageContent
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    return new Response("", { status: 404 });
  });

  const result = await processTask(
    {
      id: "t-pkg-signed-1",
      kind: "package_execute",
      payload: {
        packageId: "pkg-signed-1",
        checksum,
        signature,
        input: { n: 1 }
      },
      createdAt: new Date().toISOString(),
      quorum: 1
    },
    "node-pkg-signed-1",
    {
      ...createConfig(),
      adminApiKey: "edge-package-key",
      packageSigningKey: signingKey
    },
    deps
  );

  assert.equal(result.score > 0, true);
  assert.equal(result.payload.signatureVerified, true);
});

test("processTask rejects package when signature is invalid for packageSigningKey", async () => {
  resetPackageCacheForTests();
  const packageContent = "export function run(input){ return input; }";
  const checksum = crypto.createHash("sha256").update(packageContent).digest("hex");

  const deps = createDeps(async (url) => {
    if (String(url).includes("/packages/pkg-badsig-1")) {
      return new Response(
        JSON.stringify({
          packageId: "pkg-badsig-1",
          name: "signed-kernel",
          version: "1.0.0",
          runtime: "node",
          entrypoint: "index.js",
          permissions: [],
          checksum,
          signature: "deadbeef",
          signatureAlgorithm: "hmac-sha256",
          content: packageContent
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    return new Response("", { status: 404 });
  });

  const result = await processTask(
    {
      id: "t-pkg-badsig-1",
      kind: "package_execute",
      payload: {
        packageId: "pkg-badsig-1",
        checksum,
        input: { n: 1 }
      },
      createdAt: new Date().toISOString(),
      quorum: 1
    },
    "node-pkg-badsig-1",
    {
      ...createConfig(),
      adminApiKey: "edge-package-key",
      packageSigningKey: "edge-signing-key"
    },
    deps
  );

  assert.equal(result.score, 0);
  assert.equal(result.payload.error, "signature_invalid");
});

test("processTask rejects package when required permissions are undeclared", async () => {
  resetPackageCacheForTests();
  const packageContent = "import fs from 'node:fs'; export function run(){ return fs.readFileSync('x'); }";
  const checksum = crypto.createHash("sha256").update(packageContent).digest("hex");

  const deps = createDeps(async (url) => {
    if (String(url).includes("/packages/pkg-policy-1")) {
      return new Response(
        JSON.stringify({
          packageId: "pkg-policy-1",
          name: "policy-kernel",
          version: "1.0.0",
          runtime: "node",
          entrypoint: "index.js",
          permissions: [],
          checksum,
          content: packageContent
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    return new Response("", { status: 404 });
  });

  const result = await processTask(
    {
      id: "t-policy-1",
      kind: "package_execute",
      payload: { packageId: "pkg-policy-1", checksum, input: {} },
      createdAt: new Date().toISOString(),
      quorum: 1
    },
    "node-policy-1",
    { ...createConfig(), adminApiKey: "edge-package-key" },
    deps
  );

  assert.equal(result.score, 0);
  assert.equal(result.payload.error, "sandbox_blocked");
  assert.equal(result.payload.reason, "undeclared_permissions:filesystem");
});

test("processTask rejects package when strict policy denies declared permissions", async () => {
  resetPackageCacheForTests();
  const packageContent = "export function run(){ return process.env.TEST_KEY ?? ''; }";
  const checksum = crypto.createHash("sha256").update(packageContent).digest("hex");

  const deps = createDeps(async (url) => {
    if (String(url).includes("/packages/pkg-policy-2")) {
      return new Response(
        JSON.stringify({
          packageId: "pkg-policy-2",
          name: "policy-kernel",
          version: "1.0.0",
          runtime: "node",
          entrypoint: "index.js",
          permissions: ["environment"],
          checksum,
          content: packageContent
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    return new Response("", { status: 404 });
  });

  const result = await processTask(
    {
      id: "t-policy-2",
      kind: "package_execute",
      payload: { packageId: "pkg-policy-2", checksum, input: {} },
      createdAt: new Date().toISOString(),
      quorum: 1
    },
    "node-policy-2",
    { ...createConfig(), adminApiKey: "edge-package-key" },
    deps
  );

  assert.equal(result.score, 0);
  assert.equal(result.payload.error, "sandbox_blocked");
  assert.equal(result.payload.reason, "permission_denied:environment");
});

test("processTask allows package when relaxed policy permits declared permissions", async () => {
  resetPackageCacheForTests();
  const packageContent = "export function run(){ return process.env.TEST_KEY ?? ''; }";
  const checksum = crypto.createHash("sha256").update(packageContent).digest("hex");

  const deps = createDeps(async (url) => {
    if (String(url).includes("/packages/pkg-policy-3")) {
      return new Response(
        JSON.stringify({
          packageId: "pkg-policy-3",
          name: "policy-kernel",
          version: "1.0.0",
          runtime: "node",
          entrypoint: "index.js",
          permissions: ["environment"],
          checksum,
          content: packageContent
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    return new Response("", { status: 404 });
  });

  const result = await processTask(
    {
      id: "t-policy-3",
      kind: "package_execute",
      payload: { packageId: "pkg-policy-3", checksum, input: {} },
      createdAt: new Date().toISOString(),
      quorum: 1
    },
    "node-policy-3",
    {
      ...createConfig(),
      adminApiKey: "edge-package-key",
      packagePolicyMode: "relaxed"
    },
    deps
  );

  assert.equal(result.score > 0, true);
  assert.equal(result.payload.error, undefined);
});

test("processTask blocks package_execute when sandbox policy detects dangerous APIs", async () => {
  resetPackageCacheForTests();
  const packageContent = "import { execSync } from 'node:child_process'; export function run(){ return execSync('whoami'); }";
  const checksum = crypto.createHash("sha256").update(packageContent).digest("hex");

  const deps = createDeps(async (url) => {
    if (String(url).includes("/packages/pkg-unsafe-1")) {
      return new Response(
        JSON.stringify({
          packageId: "pkg-unsafe-1",
          runtime: "node",
          entrypoint: "index.js",
          checksum,
          content: packageContent
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response("", { status: 404 });
  });

  const result = await processTask(
    {
      id: "t-pkg-unsafe-1",
      kind: "package_execute",
      payload: {
        packageId: "pkg-unsafe-1",
        checksum,
        input: { n: 1 }
      },
      createdAt: new Date().toISOString(),
      quorum: 1
    },
    "node-pkg-unsafe-1",
    {
      ...createConfig(),
      adminApiKey: "edge-package-key"
    },
    deps
  );

  assert.equal(result.score, 0);
  assert.equal(result.payload.error, "sandbox_blocked");
  assert.equal(result.payload.reason, "child_process_blocked");
});

test("processTask rejects package_execute when runtime is unsupported", async () => {
  resetPackageCacheForTests();
  const packageContent = "export function run(){ return { ok: true }; }";
  const checksum = crypto.createHash("sha256").update(packageContent).digest("hex");

  const deps = createDeps(async (url) => {
    if (String(url).includes("/packages/pkg-runtime-1")) {
      return new Response(
        JSON.stringify({
          packageId: "pkg-runtime-1",
          runtime: "python",
          entrypoint: "main.py",
          checksum,
          content: packageContent
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response("", { status: 404 });
  });

  const result = await processTask(
    {
      id: "t-pkg-runtime-1",
      kind: "package_execute",
      payload: {
        packageId: "pkg-runtime-1",
        checksum,
        input: {}
      },
      createdAt: new Date().toISOString(),
      quorum: 1
    },
    "node-pkg-runtime-1",
    {
      ...createConfig(),
      adminApiKey: "edge-package-key"
    },
    deps
  );

  assert.equal(result.score, 0);
  assert.equal(result.payload.error, "sandbox_blocked");
  assert.equal(result.payload.reason, "unsupported_runtime");
});

test("canProcess allows desktop_gpu nodes with GPU info", () => {
  assert.equal(
    canProcess({
      charging: false,
      wifi: true,
      idle: false,
      userOptIn: true,
      nodeClass: "desktop_gpu",
      gpu: {
        vendor: "nvidia",
        model: "rtx-4090",
        vramGb: 24
      }
    }),
    true
  );

  assert.equal(
    canProcess({
      charging: true,
      wifi: true,
      idle: true,
      userOptIn: true,
      nodeClass: "desktop_gpu"
    }),
    false
  );
});

test("claimTask returns null on network error", async () => {
  const deps = createDeps(async () => {
    throw new Error("offline");
  });

  const claimed = await claimTask(createConfig(), deps);
  assert.equal(claimed, null);
});

test("claimTask sends supportedKinds derived from agent mode", async () => {
  let requestedUrl = "";
  const deps = createDeps(async (url) => {
    requestedUrl = String(url);
    return new Response("", { status: 204 });
  });

  await claimTask(
    {
      ...createConfig(),
      agentMode: "package_worker"
    },
    deps
  );

  assert.equal(requestedUrl.includes("supportedKinds=package_execute"), true);
});

test("processTask blocks disallowed task kind for configured agent mode", async () => {
  const result = await processTask(
    {
      id: "t-mode-1",
      kind: "llm_inference",
      payload: { prompt: "forbidden", modelVersion: "bio-llm-v1" },
      createdAt: new Date().toISOString(),
      quorum: 1
    },
    "node-mode-1",
    {
      ...createConfig(),
      agentMode: "mobile_safe"
    }
  );

  assert.equal(result.score, 0);
  assert.equal(result.payload.error, "task_kind_not_allowed");
});

test("sendHeartbeat returns false for non-ok response", async () => {
  const deps = createDeps(async () => new Response("", { status: 500 }));
  const sent = await sendHeartbeat(createConfig(), deps);
  assert.equal(sent, false);
});

test("registerWorker and sendWorkerHeartbeat return true for ok responses", async () => {
  const seenBodies: string[] = [];
  const deps = createDeps(async (url, init) => {
    if (String(url).includes("/workers/register")) {
      return new Response("{}", { status: 201, headers: { "content-type": "application/json" } });
    }

    if (String(url).includes("/workers/")) {
      if (init?.body && typeof init.body === "string") {
        seenBodies.push(init.body);
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }

    return new Response("", { status: 404 });
  });

  const config = {
    ...createConfig(),
    adminApiKey: "worker-key",
    agentVersion: "edge-runtime/0.1.0",
    platform: "darwin-arm64"
  };

  const registered = await registerWorker(config, deps);
  assert.equal(registered, true);

  const heartbeat = await sendWorkerHeartbeat(config, deps);
  assert.equal(heartbeat, true);
  assert.ok(seenBodies.length >= 1);
  const payload = JSON.parse(seenBodies[0]) as Record<string, unknown>;
  assert.equal(payload.status, "running");
  assert.equal(typeof payload.packageCount, "number");
});

test("submitResult returns false on network error", async () => {
  const deps = createDeps(async () => {
    throw new Error("timeout");
  });

  const submitted = await submitResult(
    createConfig(),
    "task-1",
    {
      nodeId: "edge-test-node",
      checksum: "abc",
      score: 0.5,
      payload: {}
    },
    deps
  );

  assert.equal(submitted, false);
});
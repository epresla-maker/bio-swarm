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
  checksum: string;
  key: string;
}): string {
  const payload = JSON.stringify({
    name: input.name ?? "",
    version: input.version ?? "",
    runtime: input.runtime,
    entrypoint: input.entrypoint,
    checksum: input.checksum
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
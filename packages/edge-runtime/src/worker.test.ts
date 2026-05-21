import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import type { SwarmTask } from "@bio-swarm/shared";
import {
  canProcess,
  claimTask,
  processTask,
  registerWorker,
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

  const deps = createDeps(async (url) => {
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
  const deps = createDeps(async (url) => {
    if (String(url).includes("/workers/register")) {
      return new Response("{}", { status: 201, headers: { "content-type": "application/json" } });
    }

    if (String(url).includes("/workers/")) {
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
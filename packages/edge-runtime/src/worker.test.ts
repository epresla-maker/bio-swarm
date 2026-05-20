import assert from "node:assert/strict";
import test from "node:test";
import type { SwarmTask } from "@bio-swarm/shared";
import {
  canProcess,
  claimTask,
  processTask,
  sendHeartbeat,
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

test("processTask returns deterministic structure", () => {
  const task: SwarmTask = {
    id: "t-1",
    kind: "molecule_score",
    payload: { smiles: "CCO" },
    createdAt: new Date().toISOString(),
    quorum: 1
  };

  const first = processTask(task, "node-1");
  const second = processTask(task, "node-1");

  assert.equal(first.nodeId, "node-1");
  assert.equal(first.score, second.score);
  assert.equal(first.checksum, second.checksum);
});

test("processTask handles llm_inference payload", () => {
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

  const result = processTask(task, "node-gpu-1");
  assert.equal(result.nodeId, "node-gpu-1");
  assert.equal(typeof result.payload.completion, "string");
  assert.equal(typeof result.payload.usage, "object");
  assert.equal(typeof result.score, "number");
  assert.ok(result.score >= 0);
  assert.ok(result.score <= 1);
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
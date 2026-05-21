import crypto from "node:crypto";
import type { NodeCapabilities, SwarmTask, TaskResult } from "@bio-swarm/shared";

export interface EdgeRuntimeConfig {
  orchestratorUrl: string;
  nodeId: string;
  capabilities: NodeCapabilities;
  adminApiKey?: string;
  agentVersion?: string;
  platform?: string;
  idleSleepMs: number;
  claimSleepMs: number;
  heartbeatIntervalMs: number;
}

export interface EdgeRuntimeDeps {
  fetchFn: typeof fetch;
  waitFn: (ms: number) => Promise<void>;
  setIntervalFn: typeof setInterval;
  clearIntervalFn: typeof clearInterval;
  log: Pick<Console, "log" | "error">;
}

export const defaultCapabilities: NodeCapabilities = {
  charging: true,
  wifi: true,
  idle: true,
  userOptIn: true
};

export const defaultDeps: EdgeRuntimeDeps = {
  fetchFn: fetch,
  waitFn: wait,
  setIntervalFn: setInterval,
  clearIntervalFn: clearInterval,
  log: console
};

export function canProcess(input: NodeCapabilities): boolean {
  if (!input.userOptIn || !input.wifi) {
    return false;
  }

  if (input.nodeClass === "desktop_gpu") {
    return Boolean(input.gpu && input.gpu.vramGb > 0);
  }

  return input.charging && input.idle;
}

export async function processTask(
  task: SwarmTask,
  nodeId: string,
  config?: EdgeRuntimeConfig,
  deps: EdgeRuntimeDeps = defaultDeps
): Promise<Omit<TaskResult, "taskId" | "submittedAt">> {
  let score = 0;
  let payload: Record<string, unknown> = {};

  switch (task.kind) {
    case "molecule_score":
      score = mockMoleculeScore(task.payload);
      payload = { score };
      break;
    case "embedding_generate":
      score = mockEmbeddingScore(task.payload);
      payload = { score };
      break;
    case "bio_prescreen":
      score = 0.6;
      payload = { score };
      break;
    case "hypothesis_rank":
      score = 0.7;
      payload = { score };
      break;
    case "bio_simulation": {
      const simulation = mockBioSimulation(task.payload);
      score = simulation.score;
      payload = simulation;
      break;
    }
    case "llm_inference": {
      const inference = mockLlmInference(task.payload);
      score = inference.score;
      payload = inference;
      break;
    }
    case "package_execute": {
      const executed = await executePackageTask(task.payload, config, deps);
      score = executed.score;
      payload = executed;
      break;
    }
    default:
      score = 0.5;
      payload = { score };
  }

  const checksum = crypto.createHash("sha256").update(JSON.stringify({ task, score })).digest("hex");

  return {
    nodeId,
    checksum,
    score,
    payload
  };
}

export async function claimTask(
  config: EdgeRuntimeConfig,
  deps: EdgeRuntimeDeps
): Promise<SwarmTask | null> {
  let response: Response;

  try {
    response = await deps.fetchFn(`${config.orchestratorUrl}/tasks/claim?nodeId=${config.nodeId}`);
  } catch (error) {
    deps.log.error("[edge-runtime] claim network error", error);
    return null;
  }

  if (response.status === 204) {
    return null;
  }

  if (!response.ok) {
    deps.log.error("[edge-runtime] claim failed", response.status);
    return null;
  }

  return (await response.json()) as SwarmTask;
}

export async function sendHeartbeat(config: EdgeRuntimeConfig, deps: EdgeRuntimeDeps): Promise<boolean> {
  let response: Response;

  try {
    response = await deps.fetchFn(`${config.orchestratorUrl}/nodes/${config.nodeId}/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capabilities: config.capabilities })
    });
  } catch (error) {
    deps.log.error("[edge-runtime] heartbeat network error", error);
    return false;
  }

  if (!response.ok) {
    deps.log.error("[edge-runtime] heartbeat failed", response.status);
    return false;
  }

  return true;
}

export async function registerWorker(config: EdgeRuntimeConfig, deps: EdgeRuntimeDeps): Promise<boolean> {
  if (!config.adminApiKey) {
    return false;
  }

  let response: Response;
  try {
    response = await deps.fetchFn(`${config.orchestratorUrl}/workers/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-admin-key": config.adminApiKey
      },
      body: JSON.stringify({
        workerId: config.nodeId,
        nodeId: config.nodeId,
        agentVersion: config.agentVersion ?? "edge-runtime/0.1.0",
        platform: config.platform ?? "unknown",
        status: "running"
      })
    });
  } catch (error) {
    deps.log.error("[edge-runtime] worker register network error", error);
    return false;
  }

  if (!response.ok) {
    deps.log.error("[edge-runtime] worker register failed", response.status);
    return false;
  }

  return true;
}

export async function sendWorkerHeartbeat(config: EdgeRuntimeConfig, deps: EdgeRuntimeDeps): Promise<boolean> {
  if (!config.adminApiKey) {
    return false;
  }

  let response: Response;
  try {
    response = await deps.fetchFn(`${config.orchestratorUrl}/workers/${config.nodeId}/heartbeat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-admin-key": config.adminApiKey
      },
      body: JSON.stringify({ status: "running" })
    });
  } catch (error) {
    deps.log.error("[edge-runtime] worker heartbeat network error", error);
    return false;
  }

  if (!response.ok) {
    deps.log.error("[edge-runtime] worker heartbeat failed", response.status);
    return false;
  }

  return true;
}

export async function submitResult(
  config: EdgeRuntimeConfig,
  taskId: string,
  result: Omit<TaskResult, "taskId" | "submittedAt">,
  deps: EdgeRuntimeDeps
): Promise<boolean> {
  let response: Response;

  try {
    response = await deps.fetchFn(`${config.orchestratorUrl}/tasks/${taskId}/result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(result)
    });
  } catch (error) {
    deps.log.error("[edge-runtime] submit network error", error);
    return false;
  }

  if (!response.ok) {
    deps.log.error("[edge-runtime] result submit failed", response.status);
    return false;
  }

  deps.log.log(`[edge-runtime] task ${taskId} submitted with score ${result.score.toFixed(3)}`);
  return true;
}

export function startHeartbeatLoop(config: EdgeRuntimeConfig, deps: EdgeRuntimeDeps): () => void {
  void sendHeartbeat(config, deps);
  void sendWorkerHeartbeat(config, deps);

  const interval = deps.setIntervalFn(() => {
    void sendHeartbeat(config, deps);
    void sendWorkerHeartbeat(config, deps);
  }, config.heartbeatIntervalMs);

  return () => {
    deps.clearIntervalFn(interval);
  };
}

export async function runEdgeRuntime(config: EdgeRuntimeConfig, deps: EdgeRuntimeDeps = defaultDeps): Promise<void> {
  deps.log.log(`[edge-runtime] started as ${config.nodeId}`);
  void registerWorker(config, deps);
  startHeartbeatLoop(config, deps);

  while (true) {
    if (!canProcess(config.capabilities)) {
      await deps.waitFn(config.idleSleepMs);
      continue;
    }

    const task = await claimTask(config, deps);
    if (!task) {
      await deps.waitFn(config.claimSleepMs);
      continue;
    }

    const result = await processTask(task, config.nodeId, config, deps);
    await submitResult(config, task.id, result, deps);
  }
}

async function executePackageTask(
  payload: Record<string, unknown>,
  config: EdgeRuntimeConfig | undefined,
  deps: EdgeRuntimeDeps
): Promise<Record<string, unknown> & { score: number }> {
  const packageId = typeof payload.packageId === "string" ? payload.packageId : null;
  const expectedChecksum = typeof payload.checksum === "string" ? payload.checksum : null;

  if (!packageId || !config) {
    return {
      score: 0,
      error: "invalid_package_task_payload"
    };
  }

  const pkg = await fetchWorkerPackage(config, deps, packageId);
  if (!pkg) {
    return {
      score: 0,
      packageId,
      error: "package_fetch_failed"
    };
  }

  const downloadedChecksum = String(pkg.checksum ?? "");
  if (expectedChecksum && expectedChecksum !== downloadedChecksum) {
    return {
      score: 0,
      packageId,
      error: "checksum_mismatch",
      expectedChecksum,
      downloadedChecksum
    };
  }

  const input = payload.input ?? {};
  const outputDigest = crypto
    .createHash("sha256")
    .update(JSON.stringify({ packageId, input, content: pkg.content }))
    .digest("hex");

  return {
    score: 0.9,
    packageId,
    checksumVerified: true,
    runtime: pkg.runtime,
    entrypoint: pkg.entrypoint,
    output: {
      digest: outputDigest,
      input
    }
  };
}

async function fetchWorkerPackage(
  config: EdgeRuntimeConfig,
  deps: EdgeRuntimeDeps,
  packageId: string
): Promise<{ checksum: string; runtime: string; entrypoint: string; content: string } | null> {
  const headers: Record<string, string> = {};
  if (config.adminApiKey) {
    headers["x-admin-key"] = config.adminApiKey;
  }

  let response: Response;
  try {
    response = await deps.fetchFn(`${config.orchestratorUrl}/packages/${packageId}`, {
      headers
    });
  } catch (error) {
    deps.log.error("[edge-runtime] package fetch network error", error);
    return null;
  }

  if (!response.ok) {
    deps.log.error("[edge-runtime] package fetch failed", response.status);
    return null;
  }

  const parsed = (await response.json()) as Record<string, unknown>;
  if (
    typeof parsed.checksum !== "string" ||
    typeof parsed.runtime !== "string" ||
    typeof parsed.entrypoint !== "string" ||
    typeof parsed.content !== "string"
  ) {
    return null;
  }

  return {
    checksum: parsed.checksum,
    runtime: parsed.runtime,
    entrypoint: parsed.entrypoint,
    content: parsed.content
  };
}

function mockMoleculeScore(payload: Record<string, unknown>): number {
  const seed = JSON.stringify(payload).length;
  return ((seed % 100) + 1) / 100;
}

function mockEmbeddingScore(payload: Record<string, unknown>): number {
  const text = String(payload.text ?? "biomedical");
  return Math.min(0.99, text.length / 100);
}

function mockBioSimulation(payload: Record<string, unknown>): Record<string, unknown> & { score: number } {
  const steps = typeof payload.steps === "number" ? payload.steps : 100;
  const mutationRate = typeof payload.mutationRate === "number" ? payload.mutationRate : 0.015;
  const populationSize = typeof payload.populationSize === "number" ? payload.populationSize : 512;
  const prompt = String(payload.prompt ?? "baseline");
  const modelVersion = String(payload.modelVersion ?? "bio-llm-mini");

  const stability = Math.max(0.1, 1 - Math.abs(mutationRate - 0.02) * 12);
  const scale = Math.min(1, Math.log10(Math.max(populationSize, 10)) / 4);
  const stepFactor = Math.min(1, steps / 5000);
  const promptFactor = Math.min(1, prompt.length / 240);
  const modelFactor = Math.min(1, modelVersion.length / 24);
  const score = Math.min(0.99, Math.max(0.2, (stability + scale + stepFactor + promptFactor + modelFactor) / 5));

  return {
    score,
    metrics: {
      stability,
      convergence: (stepFactor + scale) / 2,
      diversityIndex: Math.max(0, Math.min(1, mutationRate * 10))
    },
    summary: {
      steps,
      mutationRate,
      populationSize,
      modelVersion
    }
  };
}

function mockLlmInference(payload: Record<string, unknown>): Record<string, unknown> & { score: number } {
  const prompt = String(payload.prompt ?? "");
  const model = String(payload.model ?? "bio-llm-mini");
  const maxTokensRaw = Number(payload.maxTokens ?? 256);
  const temperatureRaw = Number(payload.temperature ?? 0.4);
  const maxTokens = Number.isFinite(maxTokensRaw) ? Math.min(4096, Math.max(16, Math.floor(maxTokensRaw))) : 256;
  const temperature = Number.isFinite(temperatureRaw) ? Math.min(2, Math.max(0, temperatureRaw)) : 0.4;

  const throughput = Math.max(1, Math.round(280 - temperature * 60));
  const outputTokens = Math.min(maxTokens, Math.max(24, Math.round(prompt.length * 0.8 + 32)));
  const generatedText =
    "[mock-llm] model=" +
    model +
    " tokens=" +
    outputTokens +
    " temp=" +
    temperature.toFixed(2) +
    " | response: decentralized biomedical reasoning complete.";

  const quality = Math.min(0.98, 0.55 + Math.min(prompt.length, 800) / 2000 + (1 - Math.min(temperature, 1)) * 0.2);

  return {
    score: quality,
    model,
    usage: {
      promptTokens: Math.max(1, Math.ceil(prompt.length / 4)),
      outputTokens,
      totalTokens: Math.max(1, Math.ceil(prompt.length / 4)) + outputTokens
    },
    runtime: {
      throughputTokensPerSecond: throughput,
      latencyMs: Math.round((outputTokens / throughput) * 1000)
    },
    completion: generatedText
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
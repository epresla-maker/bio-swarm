import crypto from "node:crypto";
import type { NodeCapabilities, SwarmTask, TaskKind, TaskResult } from "@bio-swarm/shared";

export type EdgeAgentMode = "full" | "mobile_safe" | "package_worker" | "llm_central";

export interface EdgeRuntimeConfig {
  orchestratorUrl: string;
  nodeId: string;
  capabilities: NodeCapabilities;
  adminApiKey?: string;
  packageSigningKey?: string;
  taskSigningKey?: string;
  packagePolicyMode?: "strict" | "relaxed";
  allowedPackagePermissions?: string[];
  agentVersion?: string;
  agentMode?: EdgeAgentMode;
  allowedTaskKinds?: TaskKind[];
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

interface WorkerHeartbeatTelemetry {
  packageCount?: number;
  lastPackageId?: string;
  lastPackageVersion?: string;
  lastPackageChecksum?: string;
  lastTaskId?: string;
  lastTaskKind?: string;
  lastExecutionStatus?: string;
  lastExecutionError?: string;
  status?: string;
  lastResultAt?: string;
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

const allTaskKinds: TaskKind[] = [
  "molecule_score",
  "embedding_generate",
  "bio_prescreen",
  "hypothesis_rank",
  "bio_simulation",
  "llm_inference",
  "package_execute"
];

const modeDefaultAllowedKinds: Record<EdgeAgentMode, TaskKind[]> = {
  full: allTaskKinds,
  mobile_safe: ["molecule_score", "embedding_generate", "bio_prescreen", "hypothesis_rank"],
  package_worker: ["package_execute"],
  llm_central: ["llm_inference", "bio_simulation", "package_execute"]
};

interface ResolvedWorkerPackage {
  packageId: string;
  name: string | null;
  version: string | null;
  checksum: string;
  signature: string | null;
  signatureAlgorithm: string | null;
  runtime: string;
  entrypoint: string;
  permissions: string[];
  content: string;
}

const packageCache = new Map<string, ResolvedWorkerPackage>();

const blockedPackagePatterns: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /node:child_process|\bchild_process\b/, reason: "child_process_blocked" },
];

const packagePermissionPatterns: Array<{ pattern: RegExp; permission: string }> = [
  { pattern: /node:fs|\bfs\b/, permission: "filesystem" },
  { pattern: /node:net|\bnet\b|node:dns|\bdns\b/, permission: "network" },
  { pattern: /process\.env/, permission: "environment" }
];

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
  const allowedKinds = resolveAllowedTaskKinds(config);
  if (!allowedKinds.has(task.kind)) {
    return {
      nodeId,
      checksum: crypto
        .createHash("sha256")
        .update(JSON.stringify({ taskId: task.id, kind: task.kind, error: "task_kind_not_allowed" }))
        .digest("hex"),
      score: 0,
      payload: {
        error: "task_kind_not_allowed",
        taskId: task.id,
        taskKind: task.kind,
        allowedTaskKinds: [...allowedKinds]
      }
    };
  }

  let score = 0;
  let payload: Record<string, unknown> = {};

  if (config?.taskSigningKey) {
    const verificationError = verifyTaskEnvelope(task, config.taskSigningKey);
    if (verificationError) {
      return {
        nodeId,
        checksum: crypto.createHash("sha256").update(JSON.stringify({ task, error: verificationError })).digest("hex"),
        score: 0,
        payload: {
          error: verificationError,
          taskId: task.id,
          taskSignatureVerified: false
        }
      };
    }
  }

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

function verifyTaskEnvelope(task: SwarmTask, signingKey: string): string | null {
  if (!task.signature || task.signatureAlgorithm !== "hmac-sha256") {
    return "task_signature_missing";
  }

  if (!task.expiresAt) {
    return "task_signature_missing";
  }

  const expiresAtMs = Date.parse(task.expiresAt);
  if (Number.isNaN(expiresAtMs) || expiresAtMs <= Date.now()) {
    return "task_signature_expired";
  }

  const payload = JSON.stringify({
    id: task.id,
    kind: task.kind,
    payload: task.payload,
    createdAt: task.createdAt,
    quorum: task.quorum,
    expiresAt: task.expiresAt
  });
  const expected = crypto.createHmac("sha256", signingKey).update(payload).digest("hex");
  if (expected !== task.signature) {
    return "task_signature_invalid";
  }

  return null;
}

export async function claimTask(
  config: EdgeRuntimeConfig,
  deps: EdgeRuntimeDeps
): Promise<SwarmTask | null> {
  let response: Response;

  try {
    const allowedKinds = [...resolveAllowedTaskKinds(config)];
    const query = new URLSearchParams({ nodeId: config.nodeId });
    if (allowedKinds.length > 0) {
      query.set("supportedKinds", allowedKinds.join(","));
    }

    response = await deps.fetchFn(`${config.orchestratorUrl}/tasks/claim?${query.toString()}`);
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

function resolveAllowedTaskKinds(config?: EdgeRuntimeConfig): Set<TaskKind> {
  const configured = (config?.allowedTaskKinds ?? [])
    .map((item) => String(item).trim())
    .filter((item): item is TaskKind => allTaskKinds.includes(item as TaskKind));

  if (configured.length > 0) {
    return new Set(configured);
  }

  const mode = config?.agentMode ?? "full";
  return new Set(modeDefaultAllowedKinds[mode]);
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
        status: "running",
        packageCount: packageCache.size,
        lastExecutionStatus: "idle"
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

export async function sendWorkerHeartbeat(
  config: EdgeRuntimeConfig,
  deps: EdgeRuntimeDeps,
  telemetry?: WorkerHeartbeatTelemetry
): Promise<boolean> {
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
      body: JSON.stringify({
        status: telemetry?.status ?? "running",
        packageCount: telemetry?.packageCount ?? packageCache.size,
        lastPackageId: telemetry?.lastPackageId,
        lastPackageVersion: telemetry?.lastPackageVersion,
        lastPackageChecksum: telemetry?.lastPackageChecksum,
        lastTaskId: telemetry?.lastTaskId,
        lastTaskKind: telemetry?.lastTaskKind,
        lastExecutionStatus: telemetry?.lastExecutionStatus,
        lastExecutionError: telemetry?.lastExecutionError,
        lastResultAt: telemetry?.lastResultAt
      })
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

  let lastTelemetry: WorkerHeartbeatTelemetry = {
    status: "running",
    lastExecutionStatus: "idle",
    packageCount: packageCache.size
  };

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

    lastTelemetry = {
      ...lastTelemetry,
      status: "running",
      lastTaskId: task.id,
      lastTaskKind: task.kind,
      lastExecutionStatus: "processing"
    };
    void sendWorkerHeartbeat(config, deps, lastTelemetry);

    const result = await processTask(task, config.nodeId, config, deps);
    const submitted = await submitResult(config, task.id, result, deps);

    const resultPayload = (result.payload ?? {}) as Record<string, unknown>;
    const executionError = typeof resultPayload.error === "string" ? resultPayload.error : null;
    lastTelemetry = {
      status: "running",
      packageCount: packageCache.size,
      lastTaskId: task.id,
      lastTaskKind: task.kind,
      lastPackageId: typeof resultPayload.packageId === "string" ? resultPayload.packageId : undefined,
      lastPackageVersion: typeof resultPayload.packageVersion === "string" ? resultPayload.packageVersion : undefined,
      lastPackageChecksum: typeof result.checksum === "string" ? result.checksum : undefined,
      lastExecutionStatus: submitted ? (executionError ? "completed_with_error" : "completed") : "submit_failed",
      lastExecutionError: executionError ?? undefined,
      lastResultAt: new Date().toISOString()
    };
    void sendWorkerHeartbeat(config, deps, lastTelemetry);
  }
}

async function executePackageTask(
  payload: Record<string, unknown>,
  config: EdgeRuntimeConfig | undefined,
  deps: EdgeRuntimeDeps
): Promise<Record<string, unknown> & { score: number }> {
  const packageIdInput = typeof payload.packageId === "string" ? payload.packageId.trim() : "";
  const packageNameInput = typeof payload.packageName === "string" ? payload.packageName.trim() : "";
  const packageVersionInput = typeof payload.packageVersion === "string" ? payload.packageVersion.trim() : "";
  const expectedChecksum = typeof payload.checksum === "string" ? payload.checksum : null;
  const expectedSignature = typeof payload.signature === "string" ? payload.signature : null;

  if (!config) {
    return {
      score: 0,
      error: "missing_runtime_config"
    };
  }

  let packageId = packageIdInput;
  let resolvedVersion: string | null = null;
  let checksumToVerify = expectedChecksum;
  let signatureToVerify = expectedSignature;

  if (!packageId) {
    if (!packageNameInput) {
      return {
        score: 0,
        error: "invalid_package_task_payload"
      };
    }

    const resolved = await resolveWorkerPackage(config, deps, {
      name: packageNameInput,
      version: packageVersionInput || undefined
    });

    if (!resolved) {
      return {
        score: 0,
        packageName: packageNameInput,
        packageVersion: packageVersionInput || null,
        error: "package_resolve_failed"
      };
    }

    packageId = resolved.packageId;
    resolvedVersion = resolved.version;
    if (!checksumToVerify) {
      checksumToVerify = resolved.checksum;
    }

    if (!signatureToVerify) {
      signatureToVerify = resolved.signature;
    }
  }

  const pkg = await loadWorkerPackage(config, deps, packageId, checksumToVerify ?? undefined);
  if (!pkg) {
    return {
      score: 0,
      packageId,
      error: "package_fetch_failed"
    };
  }

  const downloadedChecksum = String(pkg.checksum ?? "");
  if (checksumToVerify && checksumToVerify !== downloadedChecksum) {
    return {
      score: 0,
      packageId,
      error: "checksum_mismatch",
      expectedChecksum: checksumToVerify,
      downloadedChecksum
    };
  }

  const downloadedSignature = typeof pkg.signature === "string" && pkg.signature.length > 0 ? pkg.signature : null;
  if (signatureToVerify && signatureToVerify !== downloadedSignature) {
    return {
      score: 0,
      packageId,
      error: "signature_mismatch",
      expectedSignature: signatureToVerify,
      downloadedSignature
    };
  }

  if (config.packageSigningKey) {
    if (!downloadedSignature) {
      return {
        score: 0,
        packageId,
        error: "signature_missing"
      };
    }

    const calculatedSignature = calculatePackageSignature(pkg, config.packageSigningKey);
    if (calculatedSignature !== downloadedSignature) {
      return {
        score: 0,
        packageId,
        error: "signature_invalid",
        expectedSignature: calculatedSignature,
        downloadedSignature
      };
    }
  }

  const sandboxViolation = getPackageSandboxViolation(pkg, config);
  if (sandboxViolation) {
    return {
      score: 0,
      packageId,
      packageVersion: resolvedVersion ?? pkg.version,
      error: "sandbox_blocked",
      reason: sandboxViolation
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
    packageVersion: resolvedVersion ?? pkg.version,
    checksumVerified: true,
    signatureVerified:
      downloadedSignature !== null && (!signatureToVerify || signatureToVerify === downloadedSignature),
    runtime: pkg.runtime,
    entrypoint: pkg.entrypoint,
    output: {
      digest: outputDigest,
      input
    }
  };
}

function getPackageSandboxViolation(pkg: ResolvedWorkerPackage, config: EdgeRuntimeConfig): string | null {
  if (pkg.runtime !== "node") {
    return "unsupported_runtime";
  }

  for (const blocked of blockedPackagePatterns) {
    if (blocked.pattern.test(pkg.content)) {
      return blocked.reason;
    }
  }

  const requiredPermissions = getRequiredPackagePermissions(pkg);
  const declaredPermissions = new Set(pkg.permissions);
  const missingPermissions = requiredPermissions.filter((permission) => !declaredPermissions.has(permission));
  if (missingPermissions.length > 0) {
    return `undeclared_permissions:${missingPermissions.join(",")}`;
  }

  const policyMode = config.packagePolicyMode ?? "strict";
  if (policyMode === "strict") {
    const allowedPermissions = new Set(config.allowedPackagePermissions ?? []);
    const deniedPermissions = requiredPermissions.filter((permission) => !allowedPermissions.has(permission));
    if (deniedPermissions.length > 0) {
      return `permission_denied:${deniedPermissions.join(",")}`;
    }
  }

  return null;
}

function getRequiredPackagePermissions(pkg: ResolvedWorkerPackage): string[] {
  const required = new Set<string>();

  for (const pattern of packagePermissionPatterns) {
    if (pattern.pattern.test(pkg.content)) {
      required.add(pattern.permission);
    }
  }

  return Array.from(required).sort();
}

async function resolveWorkerPackage(
  config: EdgeRuntimeConfig,
  deps: EdgeRuntimeDeps,
  input: { name: string; version?: string }
): Promise<ResolvedWorkerPackage | null> {
  const params = new URLSearchParams({ name: input.name });
  if (input.version) {
    params.set("version", input.version);
  }

  let response: Response;
  try {
    response = await deps.fetchFn(`${config.orchestratorUrl}/packages/resolve?${params.toString()}`, {
      headers: buildAdminHeaders(config)
    });
  } catch (error) {
    deps.log.error("[edge-runtime] package resolve network error", error);
    return null;
  }

  if (!response.ok) {
    deps.log.error("[edge-runtime] package resolve failed", response.status);
    return null;
  }

  const parsed = (await response.json()) as Record<string, unknown>;
  if (
    typeof parsed.packageId !== "string" ||
    typeof parsed.checksum !== "string" ||
    typeof parsed.runtime !== "string" ||
    typeof parsed.entrypoint !== "string" ||
    typeof parsed.content !== "string"
  ) {
    return null;
  }

  return {
    packageId: parsed.packageId,
    name: typeof parsed.name === "string" ? parsed.name : null,
    version: typeof parsed.version === "string" ? parsed.version : null,
    checksum: parsed.checksum,
    signature: typeof parsed.signature === "string" ? parsed.signature : null,
    signatureAlgorithm: typeof parsed.signatureAlgorithm === "string" ? parsed.signatureAlgorithm : null,
    runtime: parsed.runtime,
    entrypoint: parsed.entrypoint,
    permissions: Array.isArray(parsed.permissions) ? parsed.permissions.filter((item): item is string => typeof item === "string") : [],
    content: parsed.content
  };
}

async function loadWorkerPackage(
  config: EdgeRuntimeConfig,
  deps: EdgeRuntimeDeps,
  packageId: string,
  expectedChecksum?: string
): Promise<ResolvedWorkerPackage | null> {
  const cached = packageCache.get(packageId);
  if (cached && (!expectedChecksum || cached.checksum === expectedChecksum)) {
    return cached;
  }

  const fetched = await fetchWorkerPackage(config, deps, packageId);
  if (!fetched) {
    return null;
  }

  packageCache.set(packageId, fetched);
  return fetched;
}

async function fetchWorkerPackage(
  config: EdgeRuntimeConfig,
  deps: EdgeRuntimeDeps,
  packageId: string
): Promise<ResolvedWorkerPackage | null> {

  let response: Response;
  try {
    response = await deps.fetchFn(`${config.orchestratorUrl}/packages/${packageId}`, {
      headers: buildAdminHeaders(config)
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
    typeof parsed.packageId !== "string" ||
    typeof parsed.checksum !== "string" ||
    typeof parsed.runtime !== "string" ||
    typeof parsed.entrypoint !== "string" ||
    typeof parsed.content !== "string"
  ) {
    return null;
  }

  return {
    packageId: parsed.packageId,
    name: typeof parsed.name === "string" ? parsed.name : null,
    version: typeof parsed.version === "string" ? parsed.version : null,
    checksum: parsed.checksum,
    signature: typeof parsed.signature === "string" ? parsed.signature : null,
    signatureAlgorithm: typeof parsed.signatureAlgorithm === "string" ? parsed.signatureAlgorithm : null,
    runtime: parsed.runtime,
    entrypoint: parsed.entrypoint,
    permissions: Array.isArray(parsed.permissions) ? parsed.permissions.filter((item): item is string => typeof item === "string") : [],
    content: parsed.content
  };
}

function calculatePackageSignature(pkg: ResolvedWorkerPackage, key: string): string {
  const payload = JSON.stringify({
    name: pkg.name ?? "",
    version: pkg.version ?? "",
    runtime: pkg.runtime,
    entrypoint: pkg.entrypoint,
    permissions: pkg.permissions,
    checksum: pkg.checksum
  });

  return crypto.createHmac("sha256", key).update(payload).digest("hex");
}

function buildAdminHeaders(config: EdgeRuntimeConfig): Record<string, string> {
  const headers: Record<string, string> = {};
  if (config.adminApiKey) {
    headers["x-admin-key"] = config.adminApiKey;
  }
  return headers;
}

export function resetPackageCacheForTests(): void {
  packageCache.clear();
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
export type TaskKind =
  | "molecule_score"
  | "embedding_generate"
  | "bio_prescreen"
  | "hypothesis_rank"
  | "bio_simulation"
  | "llm_inference"
  | "package_execute";

export interface NodeGpuInfo {
  vendor: string;
  model: string;
  vramGb: number;
}

export interface SwarmTask {
  id: string;
  kind: TaskKind;
  payload: Record<string, unknown>;
  createdAt: string;
  quorum: number;
}

export interface TaskClaim {
  taskId: string;
  nodeId: string;
  leasedAt: string;
}

export interface NodeCapabilities {
  charging: boolean;
  wifi: boolean;
  idle: boolean;
  userOptIn: boolean;
  nodeClass?: "mobile" | "desktop_gpu";
  gpu?: NodeGpuInfo;
}

export interface TaskResult {
  taskId: string;
  nodeId: string;
  checksum: string;
  score: number;
  payload: Record<string, unknown>;
  submittedAt: string;
}

export interface NodeStats {
  nodeId: string;
  accepted: number;
  rejected: number;
  heartbeats: number;
  lastSeenAt: string | null;
}

export interface NodeHeartbeat {
  capabilities: NodeCapabilities;
  sentAt: string;
}

export interface QueueMetrics {
  total: number;
  pending: number;
  leased: number;
  completed: number;
  failed: number;
  retries: number;
  expiredLeases: number;
}

export interface TelemetrySnapshot {
  generatedAt: string;
  queue: QueueMetrics;
  activeNodesLast60s: number;
  totalNodes: number;
}

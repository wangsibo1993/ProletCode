export { ContextManager } from "./context-manager.js";
export { TokenEstimator } from "./token-estimator.js";
export { ContextTelemetry } from "./telemetry.js";
export { snipMessages } from "./snip.js";
export { microcompact, createMicrocompactState, trackToolResult } from "./microcompact.js";
export { pruneToolResults } from "./prune.js";
export { summarize } from "./summarize.js";
export { invokeContextAgent } from "./context-agent.js";
export { reactiveCompact } from "./reactive.js";
export { collapse } from "./collapse.js";

export type {
  ContextConfig,
  ContextManagerDeps,
  ProviderCapabilities,
  PressureLevel,
  CompactionRecord,
  MicrocompactState,
  AgentCompactionResult,
  MessageMeta,
} from "./types.js";
export { DEFAULT_CONTEXT_CONFIG } from "./types.js";
export type { CompactionEvent } from "./telemetry.js";

import type { Provider } from "@proletcode/ai";

// ============================================================
// 配置
// ============================================================

export interface ContextConfig {
  snipCharThreshold: number;
  snipHeadLines: number;
  snipTailLines: number;

  microcompactKeep: number;
  cacheTTL: number;

  compactThreshold: number;
  compactTargetPressure: number;
  aggressiveThreshold: number;

  disableContextAgent: boolean;
  contextAgentTimeout: number;

  keepRecentTokens: number;
  reactiveKeepTokens: number;
  protectRecent: number;
  contextWindow: number;
}

export const DEFAULT_CONTEXT_CONFIG: ContextConfig = {
  snipCharThreshold: 20000,
  snipHeadLines: 10,
  snipTailLines: 5,

  microcompactKeep: 4,
  cacheTTL: 300_000,

  compactThreshold: 0.70,
  compactTargetPressure: 0.50,
  aggressiveThreshold: 0.85,

  disableContextAgent: true,
  contextAgentTimeout: 10_000,

  keepRecentTokens: 20_000,
  reactiveKeepTokens: 10_000,
  protectRecent: 4,
  contextWindow: 128_000,
};

// ============================================================
// 压力等级
// ============================================================

export type PressureLevel = "low" | "medium" | "high" | "critical";

// ============================================================
// 压缩记录
// ============================================================

export interface CompactionRecord {
  summary: string;
  timestamp: number;
  filesInProgress: string[];
}

// ============================================================
// Microcompact 状态
// ============================================================

export interface MicrocompactState {
  toolResults: Array<{
    id: string;
    msgIndex: number;
    toolName: string;
    timestamp: number;
  }>;
  excludedIds: Set<string>;
}

// ============================================================
// Context Agent 结果
// ============================================================

export interface AgentCompactionResult {
  success: boolean;
  pressureBefore: number;
  pressureAfter: number;
  actionsExecuted: Array<{
    tool: string;
    messageIds: string[];
    freedChars: number;
  }>;
  duration: number;
  degradedToRule: boolean;
  degradeReason?: "ineffective" | "timeout" | "llm_error";
}

// ============================================================
// 视图消息（带元数据，用于 Context Agent 决策）
// ============================================================

export interface MessageMeta {
  id: string;
  index: number;
  role: "user" | "assistant";
  type: "text" | "tool_use" | "tool_result" | "thinking";
  toolName?: string;
  chars: number;
  estimatedTokens: number;
  timestamp: number;
  excluded: boolean;
}

// ============================================================
// Provider 能力声明
// ============================================================

export interface ProviderCapabilities {
  cacheEdits: boolean;
  prefixCaching: boolean;
}

// ============================================================
// ContextManager 依赖
// ============================================================

export interface ContextManagerDeps {
  provider: Provider;
  config: ContextConfig;
  capabilities: ProviderCapabilities;
}

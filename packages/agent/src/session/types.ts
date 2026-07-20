import type { ProviderMessage } from "@proletcode/ai";

// ============================================================
// Session Header — JSONL 文件第一行
// ============================================================

export interface SessionHeader {
  type: "session_header";
  sessionId: string;
  version: 1;
  createdAt: number;
  cwd: string;
  model?: string;
}

// ============================================================
// 消息条目 — 树节点
// ============================================================

export interface UserEntry {
  type: "user";
  id: string;
  parentId: string | null;
  timestamp: number;
  message: ProviderMessage;
}

export interface AssistantEntry {
  type: "assistant";
  id: string;
  parentId: string;
  timestamp: number;
  message: ProviderMessage;
}

export interface ToolResultEntry {
  type: "tool_result";
  id: string;
  parentId: string;
  timestamp: number;
  message: ProviderMessage;
}

// ============================================================
// 压缩条目
// ============================================================

export interface CompactionEntry {
  type: "compaction";
  id: string;
  parentId: string;
  timestamp: number;
  record: SerializedCompactionRecord;
  summaryMessage: ProviderMessage;
  compactedEntryIds: string[];
}

// ============================================================
// ContextManager 状态快照
// ============================================================

export interface ContextStateEntry {
  type: "context_state";
  id: string;
  parentId: string;
  timestamp: number;
  state: SerializedContextState;
}

// ============================================================
// Leaf 指针 — 标记当前活跃分支头
// ============================================================

export interface LeafEntry {
  type: "leaf";
  id: string;
  leafId: string;
  timestamp: number;
}

// ============================================================
// 联合类型
// ============================================================

export type SessionEntry =
  | SessionHeader
  | UserEntry
  | AssistantEntry
  | ToolResultEntry
  | CompactionEntry
  | ContextStateEntry
  | LeafEntry;

// ============================================================
// 序列化辅助类型
// ============================================================

export interface SerializedCompactionRecord {
  summary: string;
  timestamp: number;
  filesInProgress: string[];
}

export interface SerializedContextState {
  messageIdCounter: number;
  lastAssistantTimestamp: number;
  lastCompaction: SerializedCompactionRecord | null;
  mcState: {
    toolResults: Array<{
      id: string;
      msgIndex: number;
      toolName: string;
      timestamp: number;
    }>;
    excludedIds: string[];
  };
}

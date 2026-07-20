import type { ProviderMessage } from "@proletcode/ai";
import type {
  SessionEntry,
  LeafEntry,
  CompactionEntry,
  ContextStateEntry,
  SerializedContextState,
  SerializedCompactionRecord,
} from "./types.js";

// ============================================================
// ConversationChain — 恢复结果
// ============================================================

export interface ConversationChain {
  messages: ProviderMessage[];
  contextState: SerializedContextState | null;
  lastCompaction: SerializedCompactionRecord | null;
  leafId: string;
}

// ============================================================
// buildConversationChain — 从 leaf 沿 parentId 向上重建消息
// ============================================================

export function buildConversationChain(entries: SessionEntry[]): ConversationChain {
  const leafId = findLeafId(entries);
  if (!leafId) {
    return { messages: [], contextState: null, lastCompaction: null, leafId: "" };
  }

  const index = new Map<string, SessionEntry>();
  let latestContextState: SerializedContextState | null = null;
  let latestContextStateTimestamp = 0;

  for (const entry of entries) {
    if (entry.type === "session_header" || entry.type === "leaf") continue;
    index.set(entry.id, entry);
    if (entry.type === "context_state" && entry.timestamp > latestContextStateTimestamp) {
      latestContextState = entry.state;
      latestContextStateTimestamp = entry.timestamp;
    }
  }

  const chain: ProviderMessage[] = [];
  let lastCompaction: SerializedCompactionRecord | null = null;
  let currentId: string | null = leafId;

  while (currentId) {
    const entry = index.get(currentId);
    if (!entry) break;

    switch (entry.type) {
      case "user":
      case "assistant":
      case "tool_result":
        chain.push(entry.message);
        currentId = entry.parentId;
        break;
      case "compaction":
        chain.push(entry.summaryMessage);
        lastCompaction = entry.record;
        currentId = null;
        break;
      case "context_state":
        currentId = entry.parentId;
        break;
      default:
        currentId = null;
    }
  }

  chain.reverse();
  return { messages: chain, contextState: latestContextState, lastCompaction, leafId };
}

// ============================================================
// findLeafId — 找到当前活跃分支的头节点 ID
// ============================================================

function findLeafId(entries: SessionEntry[]): string | null {
  // 优先找显式 LeafEntry
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === "leaf") {
      return (entries[i] as LeafEntry).leafId;
    }
  }

  // 没有显式 leaf（崩溃恢复场景）：取最后一条消息条目
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (
      entry.type === "user" ||
      entry.type === "assistant" ||
      entry.type === "tool_result" ||
      entry.type === "compaction"
    ) {
      return entry.id;
    }
  }

  return null;
}

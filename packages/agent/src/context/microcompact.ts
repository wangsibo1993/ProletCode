import type { ProviderMessage, ProviderContentBlock } from "@proletcode/ai";
import type { ContextConfig, MicrocompactState, ProviderCapabilities } from "./types.js";

const PLACEHOLDER = "[内容已压缩 — 工具结果已过时]";

export function createMicrocompactState(): MicrocompactState {
  return { toolResults: [], excludedIds: new Set() };
}

export interface MicrocompactResult {
  messages: ProviderMessage[];
  state: MicrocompactState;
  compactedCount: number;
}

export function microcompact(
  messages: ProviderMessage[],
  state: MicrocompactState,
  config: ContextConfig,
  capabilities: ProviderCapabilities,
  lastAssistantTimestamp: number
): MicrocompactResult {
  if (!capabilities.cacheEdits && !capabilities.prefixCaching) {
    return pathB(messages, state, config);
  }

  const cacheAlive = Date.now() - lastAssistantTimestamp < config.cacheTTL;
  if (cacheAlive && capabilities.cacheEdits) {
    return pathA(messages, state, config);
  }
  return pathB(messages, state, config);
}

// 路径 A: cache 存活 — 视图构建时软排除（不改存储）
function pathA(
  messages: ProviderMessage[],
  state: MicrocompactState,
  config: ContextConfig
): MicrocompactResult {
  const candidates = state.toolResults.slice(
    0,
    Math.max(0, state.toolResults.length - config.microcompactKeep)
  );

  let compactedCount = 0;
  for (const candidate of candidates) {
    if (state.excludedIds.has(candidate.id)) continue;
    state.excludedIds.add(candidate.id);
    compactedCount++;
  }

  // 路径A不修改messages，只标记excludedIds，视图构建时使用
  return { messages, state, compactedCount };
}

// 路径 B: cache 过期 — 视图中替换为占位符
function pathB(
  messages: ProviderMessage[],
  state: MicrocompactState,
  config: ContextConfig
): MicrocompactResult {
  const candidates = state.toolResults.slice(
    0,
    Math.max(0, state.toolResults.length - config.microcompactKeep)
  );

  const idsToCompact = new Set<string>();
  let compactedCount = 0;

  for (const candidate of candidates) {
    if (state.excludedIds.has(candidate.id)) continue;
    idsToCompact.add(candidate.id);
    state.excludedIds.add(candidate.id);
    compactedCount++;
  }

  if (idsToCompact.size === 0) {
    return { messages, state, compactedCount: 0 };
  }

  const result = messages.map((msg) => {
    if (typeof msg.content === "string") return msg;

    const blocks = msg.content.map((block) => {
      if (block.type !== "tool_result") return block;
      if (!idsToCompact.has(block.tool_use_id)) return block;
      return { ...block, content: PLACEHOLDER };
    });

    return { ...msg, content: blocks as ProviderContentBlock[] };
  });

  return { messages: result, state, compactedCount };
}

export function trackToolResult(
  state: MicrocompactState,
  id: string,
  msgIndex: number,
  toolName: string
): void {
  state.toolResults.push({ id, msgIndex, toolName, timestamp: Date.now() });
}

export function buildViewWithExclusions(
  messages: ProviderMessage[],
  state: MicrocompactState
): ProviderMessage[] {
  if (state.excludedIds.size === 0) return messages;

  return messages.map((msg) => {
    if (typeof msg.content === "string") return msg;

    const blocks = msg.content.map((block) => {
      if (block.type !== "tool_result") return block;
      if (!state.excludedIds.has(block.tool_use_id)) return block;
      return { ...block, content: PLACEHOLDER };
    });

    return { ...msg, content: blocks as ProviderContentBlock[] };
  });
}

import type { ProviderMessage, ProviderContentBlock } from "@proletcode/ai";
import type { ContextConfig, PressureLevel } from "./types.js";

export interface PruneResult {
  messages: ProviderMessage[];
  prunedCount: number;
  freedChars: number;
}

export function pruneToolResults(
  messages: ProviderMessage[],
  config: ContextConfig,
  pressure: PressureLevel
): PruneResult {
  if (pressure === "low" || pressure === "medium") {
    return { messages, prunedCount: 0, freedChars: 0 };
  }

  const protectFrom = messages.length - config.protectRecent;
  let prunedCount = 0;
  let freedChars = 0;

  if (pressure === "high") {
    const result = pruneDuplicates(messages, protectFrom);
    return result;
  }

  // critical: 保护区外全裁
  const result = messages.map((msg, idx) => {
    if (idx >= protectFrom) return msg;
    if (typeof msg.content === "string") return msg;

    const blocks = msg.content.map((block) => {
      if (block.type !== "tool_result") return block;
      if (block.content.length < 100) return block;

      const meta = buildMetaLine(block);
      freedChars += block.content.length - meta.length;
      prunedCount++;
      return { ...block, content: meta };
    });

    return { ...msg, content: blocks as ProviderContentBlock[] };
  });

  return { messages: result, prunedCount, freedChars };
}

// "高压"：只裁同 tool + 同参数的旧版本（latest wins）
function pruneDuplicates(
  messages: ProviderMessage[],
  protectFrom: number
): PruneResult {
  // 从后往前扫描，记录每个 tool_use 的参数签名
  const seen = new Map<string, number>(); // signature → latest msgIndex
  const toolUseInputs = new Map<string, string>(); // tool_use_id → signature

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (typeof msg.content === "string") continue;
    for (const block of msg.content) {
      if (block.type === "tool_use") {
        const sig = `${block.name}:${JSON.stringify(block.input)}`;
        toolUseInputs.set(block.id, sig);
        if (!seen.has(sig)) {
          seen.set(sig, i);
        }
      }
    }
  }

  let prunedCount = 0;
  let freedChars = 0;

  const result = messages.map((msg, idx) => {
    if (idx >= protectFrom) return msg;
    if (typeof msg.content === "string") return msg;

    const blocks = msg.content.map((block) => {
      if (block.type !== "tool_result") return block;

      const sig = toolUseInputs.get(block.tool_use_id);
      if (!sig) return block;

      const latestIdx = seen.get(sig);
      if (latestIdx === undefined || latestIdx <= idx) return block;

      // 此条是旧版本，裁掉
      if (block.content.length < 100) return block;
      const meta = buildMetaLine(block, "(已有更新版本)");
      freedChars += block.content.length - meta.length;
      prunedCount++;
      return { ...block, content: meta };
    });

    return { ...msg, content: blocks as ProviderContentBlock[] };
  });

  return { messages: result, prunedCount, freedChars };
}

function buildMetaLine(
  block: { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean },
  note?: string
): string {
  const size = block.content.length;
  const preview = block.content.slice(0, 80).replace(/\n/g, " ");
  const suffix = note ? ` ${note}` : "";
  return `[tool_result: ${size} chars, "${preview}..."${suffix}]`;
}

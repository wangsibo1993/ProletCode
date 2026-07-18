import type { ProviderMessage } from "@proletcode/ai";
import type { CompactionRecord } from "./types.js";

export interface CollapseResult {
  messages: ProviderMessage[];
  record: CompactionRecord;
}

export function collapse(
  messages: ProviderMessage[],
  previousRecord: CompactionRecord | null
): CollapseResult {
  const summary = previousRecord
    ? previousRecord.summary
    : buildEmergencySummary(messages);

  // 保留最后 2 条消息
  const kept = messages.slice(-2);

  // 摘要以 user role 注入（借鉴 opencode 的 role mutation）
  const summaryMessage: ProviderMessage = {
    role: "user",
    content: [
      {
        type: "text",
        text: `<context-collapsed>\n之前的对话已被压缩。摘要：\n${summary}\n</context-collapsed>`,
      },
    ],
  };

  const record: CompactionRecord = {
    summary,
    timestamp: Date.now(),
    filesInProgress: previousRecord?.filesInProgress ?? [],
  };

  return {
    messages: [summaryMessage, ...kept],
    record,
  };
}

function buildEmergencySummary(messages: ProviderMessage[]): string {
  const parts: string[] = [];
  for (const msg of messages.slice(-6)) {
    if (typeof msg.content === "string") {
      parts.push(msg.content.slice(0, 200));
      continue;
    }
    for (const block of msg.content) {
      if (block.type === "text") {
        parts.push(block.text.slice(0, 200));
      } else if (block.type === "tool_use") {
        parts.push(`[调用 ${block.name}]`);
      }
    }
  }
  return parts.join("\n");
}

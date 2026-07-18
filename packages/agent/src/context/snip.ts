import type { ProviderMessage, ProviderContentBlock } from "@proletcode/ai";
import type { ContextConfig } from "./types.js";

export interface SnipResult {
  messages: ProviderMessage[];
  snipped: boolean;
  snippedCount: number;
}

export function snipMessages(
  messages: ProviderMessage[],
  config: ContextConfig
): SnipResult {
  const protectFrom = messages.length - config.protectRecent;
  let snipped = false;
  let snippedCount = 0;

  const result = messages.map((msg, idx) => {
    if (idx >= protectFrom) return msg;
    if (typeof msg.content === "string") return msg;

    const blocks = msg.content.map((block) => {
      if (block.type !== "tool_result") return block;
      if (block.content.length <= config.snipCharThreshold) return block;

      snipped = true;
      snippedCount++;
      const truncated = truncateHeadTail(
        block.content,
        config.snipHeadLines,
        config.snipTailLines
      );
      return { ...block, content: truncated };
    });

    return { ...msg, content: blocks as ProviderContentBlock[] };
  });

  return { messages: result, snipped, snippedCount };
}

function truncateHeadTail(
  content: string,
  headLines: number,
  tailLines: number
): string {
  const lines = content.split("\n");
  if (lines.length <= headLines + tailLines) return content;

  const head = lines.slice(0, headLines);
  const tail = lines.slice(-tailLines);
  const omitted = lines.length - headLines - tailLines;

  return [
    ...head,
    `\n... [省略 ${omitted} 行，原始 ${content.length} 字符] ...\n`,
    ...tail,
  ].join("\n");
}

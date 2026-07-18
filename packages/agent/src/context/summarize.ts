import type { Provider, ProviderMessage } from "@proletcode/ai";
import type { ContextConfig, CompactionRecord } from "./types.js";

const SUMMARIZATION_PROMPT = `你是一个上下文压缩助手。请将以下对话历史压缩为结构化摘要。

输出格式：
## 目标
[用户当前在做什么]

## 约束
[用户提出的限制条件]

## 进展
[已完成的步骤，用列表]

## 关键决策
[做出的重要选择及原因]

## 下一步
[接下来应该做什么]

## 关键文件
[涉及的文件路径列表]

注意：只保留对继续工作有用的信息，去除过程细节。`;

const UPDATE_SUMMARIZATION_PROMPT = `你是一个上下文压缩助手。已有一份之前的摘要，请根据新增的对话内容更新摘要。

规则：
1. 保留之前摘要中仍然有效的信息
2. 用新信息更新或覆盖过时的部分
3. 新完成的步骤追加到"进展"中
4. 保持相同的输出格式

<previous-summary>
{previous_summary}
</previous-summary>

请根据下面的新增对话更新摘要：`;

export interface SummarizeResult {
  messages: ProviderMessage[];
  record: CompactionRecord;
  llmInputTokens: number;
  llmOutputTokens: number;
}

export async function summarize(
  messages: ProviderMessage[],
  previousRecord: CompactionRecord | null,
  provider: Provider,
  config: ContextConfig
): Promise<SummarizeResult> {
  const cutPoint = findCutPoint(messages, config);
  const toSummarize = messages.slice(0, cutPoint);
  const toKeep = messages.slice(cutPoint);

  const prompt = previousRecord
    ? UPDATE_SUMMARIZATION_PROMPT.replace("{previous_summary}", previousRecord.summary)
    : SUMMARIZATION_PROMPT;

  const summaryMessages: ProviderMessage[] = [
    {
      role: "user",
      content: [
        { type: "text", text: formatMessagesForSummary(toSummarize) },
      ],
    },
  ];

  let summaryText = "";
  let inputTokens = 0;
  let outputTokens = 0;

  const stream = provider.stream(summaryMessages, {
    systemPrompt: prompt,
    tools: [],
    maxTokens: 2048,
  });

  for await (const event of stream) {
    if (event.type === "message_end") {
      for (const block of event.message.content) {
        if (block.type === "text") {
          summaryText += block.text;
        }
      }
    }
  }

  // token 估算（API 未返回时的近似值）
  inputTokens = Math.ceil(
    (prompt.length + formatMessagesForSummary(toSummarize).length) / 4
  );
  outputTokens = Math.ceil(summaryText.length / 4);

  const filesInProgress = extractFilePaths(summaryText);

  const record: CompactionRecord = {
    summary: summaryText,
    timestamp: Date.now(),
    filesInProgress,
  };

  // 构建压缩后的消息：摘要 + 保留的消息
  const summaryMessage: ProviderMessage = {
    role: "user",
    content: [
      {
        type: "text",
        text: `<context-summary>\n${summaryText}\n</context-summary>`,
      },
    ],
  };

  const resultMessages: ProviderMessage[] = [summaryMessage, ...toKeep];

  return {
    messages: resultMessages,
    record,
    llmInputTokens: inputTokens,
    llmOutputTokens: outputTokens,
  };
}

function findCutPoint(messages: ProviderMessage[], config: ContextConfig): number {
  // 从后往前计算 token，找到保护区边界
  let tokenCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const chars = typeof msg.content === "string"
      ? msg.content.length
      : msg.content.reduce((sum, b) => {
          if ("text" in b) return sum + (b as { text: string }).text.length;
          if ("thinking" in b) return sum + (b as { thinking: string }).thinking.length;
          if ("content" in b && b.type === "tool_result")
            return sum + (b as { content: string }).content.length;
          return sum + 100;
        }, 0);

    tokenCount += Math.ceil(chars / 4);
    if (tokenCount >= config.keepRecentTokens) {
      return i + 1;
    }
  }
  return Math.max(1, Math.floor(messages.length / 2));
}

function formatMessagesForSummary(messages: ProviderMessage[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      parts.push(`[${msg.role}]: ${msg.content}`);
      continue;
    }
    for (const block of msg.content) {
      if (block.type === "text") {
        parts.push(`[${msg.role}]: ${block.text}`);
      } else if (block.type === "tool_use") {
        parts.push(`[assistant/tool_use]: ${block.name}(${JSON.stringify(block.input).slice(0, 200)})`);
      } else if (block.type === "tool_result") {
        const preview = block.content.slice(0, 500);
        parts.push(`[tool_result]: ${preview}${block.content.length > 500 ? "..." : ""}`);
      }
    }
  }
  return parts.join("\n");
}

function extractFilePaths(summary: string): string[] {
  const paths: string[] = [];
  const regex = /(?:^|\s)((?:\.\/|\/|packages\/|src\/)[^\s,)}\]]+)/gm;
  let match;
  while ((match = regex.exec(summary)) !== null) {
    paths.push(match[1]);
  }
  return [...new Set(paths)];
}

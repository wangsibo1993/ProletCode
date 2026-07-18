import type { Provider, ProviderMessage } from "@proletcode/ai";
import type { ContextConfig, CompactionRecord } from "./types.js";
import { snipMessages } from "./snip.js";
import { pruneToolResults } from "./prune.js";
import { summarize } from "./summarize.js";

export interface ReactiveResult {
  messages: ProviderMessage[];
  record: CompactionRecord;
  prunedCount: number;
  freedChars: number;
}

export async function reactiveCompact(
  messages: ProviderMessage[],
  previousRecord: CompactionRecord | null,
  provider: Provider,
  config: ContextConfig
): Promise<ReactiveResult> {
  // 用更小的保护区
  const reactiveConfig: ContextConfig = {
    ...config,
    keepRecentTokens: config.reactiveKeepTokens,
    protectRecent: 2,
    snipHeadLines: 5,
    snipTailLines: 3,
  };

  // Step 1: 激进 snip
  const { messages: snipped } = snipMessages(messages, reactiveConfig);

  // Step 2: critical 级裁剪
  const { messages: pruned, prunedCount, freedChars } = pruneToolResults(
    snipped,
    reactiveConfig,
    "critical"
  );

  // Step 3: 增量摘要
  const { messages: summarized, record } = await summarize(
    pruned,
    previousRecord,
    provider,
    reactiveConfig
  );

  return { messages: summarized, record, prunedCount, freedChars };
}

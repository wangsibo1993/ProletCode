import type {
  Provider,
  ProviderMessage,
  ProviderContentBlock,
  ContentBlock,
  ToolDefinition,
  StopReason,
} from "@proletcode/ai";
import type { AgentEvent, Terminal } from "./types.js";
import type { ToolRegistry } from "./tools/registry.js";
import type { ToolContext } from "./tools/types.js";
import { ContextManager } from "./context/context-manager.js";
import type { ContextConfig, ProviderCapabilities } from "./context/types.js";
import type { SerializedContextState } from "./session/types.js";

export interface AgentLoopParams {
  provider: Provider;
  registry: ToolRegistry;
  messages: ProviderMessage[];
  systemPrompt: string;
  tools: ToolDefinition[];
  maxTurns?: number;
  signal?: AbortSignal;
  cwd: string;
  contextConfig?: Partial<ContextConfig>;
  providerCapabilities?: ProviderCapabilities;
  contextState?: SerializedContextState;
}

export async function* agentLoop(params: AgentLoopParams): AsyncGenerator<AgentEvent, Terminal> {
  const maxTurns = params.maxTurns ?? 10;
  const messages: ProviderMessage[] = [...params.messages];
  let turnCount = 0;

  const toolContext: ToolContext = {
    cwd: params.cwd,
    signal: params.signal ?? new AbortController().signal,
  };

  const contextManager = new ContextManager({
    provider: params.provider,
    config: params.contextConfig ?? {},
    capabilities: params.providerCapabilities ?? { cacheEdits: false, prefixCaching: false },
  } as any);

  if (params.contextState) {
    contextManager.restoreState(params.contextState);
  }

  while (true) {
    if (params.signal?.aborted) {
      yield { type: "context_state_changed", state: contextManager.exportState() };
      return { reason: "aborted" };
    }

    turnCount++;
    if (turnCount > maxTurns) {
      yield { type: "context_state_changed", state: contextManager.exportState() };
      return { reason: "max_turns" };
    }

    yield { type: "turn_start" };

    let assistantContent: ContentBlock[] = [];
    let stopReason: StopReason = "end_turn";

    // 时机 3：API 调用前 — 压力压缩
    const viewMessages = await contextManager.beforeApiCall(messages);

    try {
      const stream = params.provider.stream(viewMessages, {
        systemPrompt: params.systemPrompt,
        tools: params.tools,
        maxTokens: 8192,
        signal: params.signal,
      });

      for await (const event of stream) {
        switch (event.type) {
          case "thinking_delta":
            yield { type: "thinking_delta", delta: event.delta };
            break;
          case "text_delta":
            yield { type: "text_delta", delta: event.delta };
            break;
          case "message_end":
            assistantContent = event.message.content;
            stopReason = event.message.stopReason;
            break;
        }
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));

      // 时机 4：overflow 检测
      if (isOverflowError(error)) {
        const recovered = await contextManager.onOverflowError(messages);
        messages.length = 0;
        messages.push(...recovered);
        continue;
      }

      yield { type: "error", error };
      return { reason: "error", error };
    }

    const toolUseBlocks = assistantContent.filter(
      (b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use"
    );

    if (toolUseBlocks.length === 0) {
      // 时机 2：每轮结束 — Microcompact
      const postTurn = contextManager.onTurnEnd(messages);
      messages.length = 0;
      messages.push(...postTurn);

      yield { type: "turn_end", stopReason };
      yield { type: "context_state_changed", state: contextManager.exportState() };
      return { reason: "completed" };
    }

    const assistantMessage: ProviderMessage = {
      role: "assistant",
      content: assistantContent as ProviderContentBlock[],
    };
    messages.push(assistantMessage);
    yield { type: "message_appended", message: assistantMessage, role: "assistant" };

    for (const toolUse of toolUseBlocks) {
      yield { type: "tool_use_start", name: toolUse.name, id: toolUse.id, input: toolUse.input as Record<string, unknown> };

      const result = await params.registry.execute(toolUse.name, toolUse.input, toolContext);

      yield { type: "tool_use_end", name: toolUse.name, id: toolUse.id, result };

      const toolResultMessage: ProviderMessage = {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: result.content,
            is_error: result.isError,
          },
        ],
      };
      messages.push(toolResultMessage);
      yield { type: "message_appended", message: toolResultMessage, role: "tool_result" };

      // 时机 1：消息入队 — Snip
      const snipped = contextManager.onMessageAdded(messages);
      messages.length = 0;
      messages.push(...snipped);
    }

    // 时机 2：工具轮结束 — Microcompact
    const postTurn = contextManager.onTurnEnd(messages);
    messages.length = 0;
    messages.push(...postTurn);
  }
}

function isOverflowError(error: Error): boolean {
  const msg = error.message.toLowerCase();
  return (
    msg.includes("context_length_exceeded") ||
    msg.includes("max_tokens") ||
    msg.includes("too many tokens") ||
    msg.includes("context window")
  );
}

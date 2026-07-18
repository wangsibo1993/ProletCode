import Anthropic from "@anthropic-ai/sdk";
import type { Provider, ProviderMessage, StreamOptions, StreamEvent, AssistantMessage, ContentBlock, StopReason } from "./types.js";

export interface MiniMaxConfig {
  apiKey: string;
  baseURL: string;
  model: string;
}

export function createMiniMaxProvider(config: MiniMaxConfig): Provider {
  const client = new Anthropic({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
  });

  return {
    async *stream(messages: ProviderMessage[], options: StreamOptions): AsyncGenerator<StreamEvent> {
      const response = await client.messages.create({
        model: config.model,
        max_tokens: options.maxTokens,
        system: options.systemPrompt,
        messages: messages as Anthropic.MessageParam[],
        tools: options.tools as Anthropic.Tool[],
        thinking: { type: "enabled", budget_tokens: 4096 },
        stream: true,
      }, {
        signal: options.signal,
      });

      yield { type: "message_start" };

      const contentBlocks: ContentBlock[] = [];
      let currentToolInput = "";
      let stopReason: StopReason = "end_turn";

      for await (const event of response) {
        switch (event.type) {
          case "content_block_start": {
            const block = event.content_block;
            if (block.type === "thinking") {
              contentBlocks[event.index] = { type: "thinking", thinking: "" };
            } else if (block.type === "tool_use") {
              contentBlocks[event.index] = {
                type: "tool_use",
                id: block.id,
                name: block.name,
                input: {},
              };
              currentToolInput = "";
              yield { type: "tool_use_start", index: event.index, id: block.id, name: block.name };
            } else if (block.type === "text") {
              contentBlocks[event.index] = { type: "text", text: "" };
            }
            break;
          }

          case "content_block_delta": {
            const delta = event.delta;
            if (delta.type === "thinking_delta") {
              const block = contentBlocks[event.index] as { type: "thinking"; thinking: string };
              block.thinking += delta.thinking;
              yield { type: "thinking_delta", delta: delta.thinking };
            } else if (delta.type === "text_delta") {
              const block = contentBlocks[event.index] as { type: "text"; text: string };
              block.text += delta.text;
              yield { type: "text_delta", delta: delta.text };
            } else if (delta.type === "input_json_delta") {
              currentToolInput += delta.partial_json;
              yield { type: "tool_use_delta", index: event.index, delta: delta.partial_json };
            }
            break;
          }

          case "content_block_stop": {
            const block = contentBlocks[event.index];
            if (block?.type === "tool_use") {
              try {
                block.input = JSON.parse(currentToolInput || "{}");
              } catch {
                block.input = {};
              }
              yield { type: "tool_use_end", index: event.index };
            }
            break;
          }

          case "message_delta": {
            if ("delta" in event && event.delta) {
              stopReason = (event.delta as { stop_reason?: string }).stop_reason as StopReason ?? "end_turn";
            }
            break;
          }
        }
      }

      const assistantMessage: AssistantMessage = {
        role: "assistant",
        content: contentBlocks,
        stopReason,
      };

      yield { type: "message_end", message: assistantMessage };
    },
  };
}

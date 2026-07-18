import type { ProviderMessage } from "@proletcode/ai";
import type { ContextConfig, PressureLevel } from "./types.js";

const CHARS_PER_TOKEN = 4;
const JSON_CHARS_PER_TOKEN = 2;

export class TokenEstimator {
  private lastApiTokens: number | null = null;
  private lastApiMessageCount: number | null = null;
  private pendingSinceLastApi: number = 0;

  updateFromApiUsage(inputTokens: number, messageCount: number): void {
    this.lastApiTokens = inputTokens;
    this.lastApiMessageCount = messageCount;
    this.pendingSinceLastApi = 0;
  }

  estimate(messages: ProviderMessage[]): number {
    if (this.lastApiTokens !== null && this.lastApiMessageCount !== null) {
      const newMessages = messages.slice(this.lastApiMessageCount);
      const newTokens = this.estimateMessages(newMessages);
      this.pendingSinceLastApi = newTokens;
      return this.lastApiTokens + newTokens;
    }
    return this.estimateMessages(messages);
  }

  getPressure(messages: ProviderMessage[], config: ContextConfig): number {
    const tokens = this.estimate(messages);
    return tokens / config.contextWindow;
  }

  getPressureLevel(messages: ProviderMessage[], config: ContextConfig): PressureLevel {
    const pressure = this.getPressure(messages, config);
    if (pressure >= 0.90) return "critical";
    if (pressure >= config.aggressiveThreshold) return "high";
    if (pressure >= config.compactThreshold) return "medium";
    return "low";
  }

  private estimateMessages(messages: ProviderMessage[]): number {
    let total = 0;
    for (const msg of messages) {
      total += this.estimateMessage(msg);
    }
    return total;
  }

  private estimateMessage(msg: ProviderMessage): number {
    if (typeof msg.content === "string") {
      return Math.ceil(msg.content.length / CHARS_PER_TOKEN);
    }
    let tokens = 0;
    for (const block of msg.content) {
      tokens += this.estimateBlock(block);
    }
    return tokens;
  }

  private estimateBlock(block: Record<string, unknown>): number {
    switch (block.type) {
      case "text":
        return Math.ceil((block.text as string).length / CHARS_PER_TOKEN);
      case "thinking":
        return Math.ceil((block.thinking as string).length / CHARS_PER_TOKEN);
      case "tool_use": {
        const inputStr = JSON.stringify(block.input ?? {});
        return Math.ceil(inputStr.length / JSON_CHARS_PER_TOKEN) + 20;
      }
      case "tool_result":
        return Math.ceil((block.content as string).length / CHARS_PER_TOKEN);
      default:
        return 0;
    }
  }
}

import type { Provider, ProviderMessage } from "@proletcode/ai";
import type {
  ContextConfig,
  ContextManagerDeps,
  CompactionRecord,
  MicrocompactState,
  MessageMeta,
  PressureLevel,
  AgentCompactionResult,
} from "./types.js";
import type { SerializedContextState } from "../session/types.js";
import { DEFAULT_CONTEXT_CONFIG } from "./types.js";
import { TokenEstimator } from "./token-estimator.js";
import { snipMessages } from "./snip.js";
import {
  microcompact,
  createMicrocompactState,
  trackToolResult,
  buildViewWithExclusions,
} from "./microcompact.js";
import { pruneToolResults } from "./prune.js";
import { summarize } from "./summarize.js";
import { invokeContextAgent } from "./context-agent.js";
import { reactiveCompact } from "./reactive.js";
import { collapse } from "./collapse.js";
import { ContextTelemetry } from "./telemetry.js";
import type { CompactionEvent } from "./telemetry.js";

export class ContextManager {
  private estimator: TokenEstimator;
  private mcState: MicrocompactState;
  private lastCompaction: CompactionRecord | null = null;
  private telemetry: ContextTelemetry;
  private lastAssistantTimestamp: number = 0;
  private messageIdCounter: number = 0;
  private messageIds: Map<number, string> = new Map();

  private provider: Provider;
  private config: ContextConfig;
  private deps: ContextManagerDeps;

  constructor(deps: ContextManagerDeps) {
    this.deps = deps;
    this.provider = deps.provider;
    this.config = { ...DEFAULT_CONTEXT_CONFIG, ...deps.config };
    this.estimator = new TokenEstimator();
    this.mcState = createMicrocompactState();
    this.telemetry = new ContextTelemetry();
  }

  // 时机 1：消息入队时 → Snip
  onMessageAdded(messages: ProviderMessage[]): ProviderMessage[] {
    const before = this.snapshot(messages);
    const { messages: result, snipped, snippedCount } = snipMessages(messages, this.config);

    if (snipped) {
      this.telemetry.record(this.buildEvent("snip", "entry", before, result, snippedCount));
    }

    // 追踪 tool_result
    const lastMsg = messages[messages.length - 1];
    if (lastMsg && typeof lastMsg.content !== "string") {
      for (const block of lastMsg.content) {
        if (block.type === "tool_result") {
          const id = this.assignMessageId(messages.length - 1);
          trackToolResult(this.mcState, block.tool_use_id, messages.length - 1, "");
        }
      }
    }

    return result;
  }

  // 时机 2：每轮结束 → Microcompact
  onTurnEnd(messages: ProviderMessage[]): ProviderMessage[] {
    this.lastAssistantTimestamp = Date.now();

    const before = this.snapshot(messages);
    const { messages: result, state, compactedCount } = microcompact(
      messages,
      this.mcState,
      this.config,
      this.deps.capabilities,
      this.lastAssistantTimestamp
    );
    this.mcState = state;

    if (compactedCount > 0) {
      this.telemetry.record(
        this.buildEvent("microcompact", "turn_end", before, result, compactedCount)
      );
    }

    return result;
  }

  // 时机 3：API 调用前 → 压力压缩（Context Agent 优先，降级为 Rule）
  async beforeApiCall(messages: ProviderMessage[]): Promise<ProviderMessage[]> {
    const pressure = this.estimator.getPressure(messages, this.config);
    if (pressure < this.config.compactThreshold) {
      return buildViewWithExclusions(messages, this.mcState);
    }

    const pressureLevel = this.estimator.getPressureLevel(messages, this.config);
    let result = messages;

    if (!this.config.disableContextAgent) {
      const agentResult = await this.tryContextAgent(messages, pressureLevel);

      if (agentResult.success) {
        // Agent 成功：应用其决策
        result = this.applyAgentActions(messages, agentResult);
        const afterPressure = this.estimator.getPressure(result, this.config);
        agentResult.pressureAfter = afterPressure;
        this.telemetry.recordAgentResult(agentResult);

        if (afterPressure < this.config.compactThreshold) {
          return buildViewWithExclusions(result, this.mcState);
        }
        // Agent 效果不够，继续走 Rule 补充
      } else {
        this.telemetry.recordAgentResult(agentResult);
      }
    }

    // Rule 管线
    result = await this.rulePipeline(result, pressureLevel);
    return buildViewWithExclusions(result, this.mcState);
  }

  // 时机 4：API overflow → Reactive/Collapse
  async onOverflowError(messages: ProviderMessage[]): Promise<ProviderMessage[]> {
    const before = this.snapshot(messages);

    try {
      const { messages: result, record } = await reactiveCompact(
        messages,
        this.lastCompaction,
        this.provider,
        this.config
      );
      this.lastCompaction = record;
      this.telemetry.record(this.buildEvent("reactive", "overflow", before, result, 0));
      return result;
    } catch {
      // reactive 也失败了 → collapse
      const { messages: result, record } = collapse(messages, this.lastCompaction);
      this.lastCompaction = record;
      this.telemetry.record(this.buildEvent("collapse", "overflow", before, result, 0));
      return result;
    }
  }

  // API 成功后更新 token 基线
  onApiSuccess(inputTokens: number, messageCount: number): void {
    this.estimator.updateFromApiUsage(inputTokens, messageCount);
  }

  getTelemetry(): ContextTelemetry {
    return this.telemetry;
  }

  // --- 内部方法 ---

  private async tryContextAgent(
    messages: ProviderMessage[],
    _pressureLevel: PressureLevel
  ): Promise<AgentCompactionResult> {
    const metas = this.buildMessageMetas(messages);
    return invokeContextAgent(messages, metas, this.provider, this.config, this.estimator);
  }

  private async rulePipeline(
    messages: ProviderMessage[],
    pressureLevel: PressureLevel
  ): Promise<ProviderMessage[]> {
    let result = messages;

    // Prune
    if (pressureLevel === "high" || pressureLevel === "critical") {
      const before = this.snapshot(result);
      const pruned = pruneToolResults(result, this.config, pressureLevel);
      result = pruned.messages;
      if (pruned.prunedCount > 0) {
        this.telemetry.record(
          this.buildEvent("prune", "pressure", before, result, pruned.prunedCount)
        );
      }
    }

    // 检查 prune 后是否够了
    const afterPrunePressure = this.estimator.getPressure(result, this.config);
    if (afterPrunePressure < this.config.compactThreshold) {
      return result;
    }

    // Summarize
    if (pressureLevel === "high" || pressureLevel === "critical") {
      const before = this.snapshot(result);
      const { messages: summarized, record, llmInputTokens, llmOutputTokens } =
        await summarize(result, this.lastCompaction, this.provider, this.config);
      this.lastCompaction = record;
      result = summarized;

      const event = this.buildEvent("summarize", "pressure", before, result, 0);
      event.llmCallMade = true;
      event.llmInputTokens = llmInputTokens;
      event.llmOutputTokens = llmOutputTokens;
      this.telemetry.record(event);
    }

    return result;
  }

  private applyAgentActions(
    messages: ProviderMessage[],
    result: AgentCompactionResult
  ): ProviderMessage[] {
    // 将 Agent 的 exclude 决策应用到 mcState
    for (const action of result.actionsExecuted) {
      if (action.tool === "exclude_messages") {
        for (const id of action.messageIds) {
          this.mcState.excludedIds.add(id);
        }
      }
    }
    return messages;
  }

  private buildMessageMetas(messages: ProviderMessage[]): MessageMeta[] {
    const metas: MessageMeta[] = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const id = this.getMessageId(i);

      if (typeof msg.content === "string") {
        metas.push({
          id,
          index: i,
          role: msg.role,
          type: "text",
          chars: msg.content.length,
          estimatedTokens: Math.ceil(msg.content.length / 4),
          timestamp: 0,
          excluded: this.mcState.excludedIds.has(id),
        });
        continue;
      }

      for (const block of msg.content) {
        const chars =
          block.type === "text" ? block.text.length :
          block.type === "thinking" ? block.thinking.length :
          block.type === "tool_result" ? block.content.length :
          JSON.stringify(block.input ?? {}).length;

        metas.push({
          id: block.type === "tool_result" ? block.tool_use_id : id,
          index: i,
          role: msg.role,
          type: block.type as MessageMeta["type"],
          toolName: block.type === "tool_use" ? block.name : undefined,
          chars,
          estimatedTokens: Math.ceil(chars / 4),
          timestamp: 0,
          excluded: block.type === "tool_result"
            ? this.mcState.excludedIds.has(block.tool_use_id)
            : false,
        });
      }
    }
    return metas;
  }

  private assignMessageId(index: number): string {
    const id = `msg_${this.messageIdCounter++}`;
    this.messageIds.set(index, id);
    return id;
  }

  private getMessageId(index: number): string {
    return this.messageIds.get(index) ?? `msg_${index}`;
  }

  private snapshot(messages: ProviderMessage[]) {
    let toolResultCount = 0;
    for (const msg of messages) {
      if (typeof msg.content === "string") continue;
      for (const block of msg.content) {
        if (block.type === "tool_result") toolResultCount++;
      }
    }
    return {
      messageCount: messages.length,
      tokenEstimate: this.estimator.estimate(messages),
      toolResultCount,
    };
  }

  private buildEvent(
    layer: CompactionEvent["layer"],
    trigger: CompactionEvent["trigger"],
    before: { messageCount: number; tokenEstimate: number; toolResultCount: number },
    afterMessages: ProviderMessage[],
    affectedCount: number
  ): CompactionEvent {
    const after = this.snapshot(afterMessages);
    const pressureBefore = before.tokenEstimate / this.config.contextWindow;
    const pressureAfter = after.tokenEstimate / this.config.contextWindow;

    return {
      timestamp: Date.now(),
      layer,
      trigger,
      before,
      after,
      affected: [],
      llmCallMade: false,
      pressure: {
        before: this.levelFromPressure(pressureBefore),
        after: this.levelFromPressure(pressureAfter),
      },
      freedTokens: before.tokenEstimate - after.tokenEstimate,
      duration: 0,
    };
  }

  private levelFromPressure(p: number): PressureLevel {
    if (p >= 0.90) return "critical";
    if (p >= this.config.aggressiveThreshold) return "high";
    if (p >= this.config.compactThreshold) return "medium";
    return "low";
  }

  exportState(): SerializedContextState {
    return {
      messageIdCounter: this.messageIdCounter,
      lastAssistantTimestamp: this.lastAssistantTimestamp,
      lastCompaction: this.lastCompaction,
      mcState: {
        toolResults: [...this.mcState.toolResults],
        excludedIds: [...this.mcState.excludedIds],
      },
    };
  }

  restoreState(state: SerializedContextState): void {
    this.messageIdCounter = state.messageIdCounter;
    this.lastAssistantTimestamp = state.lastAssistantTimestamp;
    this.lastCompaction = state.lastCompaction;
    this.mcState = {
      toolResults: [...state.mcState.toolResults],
      excludedIds: new Set(state.mcState.excludedIds),
    };
  }
}

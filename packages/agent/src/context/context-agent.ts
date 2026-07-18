import type { Provider, ProviderMessage } from "@proletcode/ai";
import type { ContextConfig, AgentCompactionResult, MessageMeta } from "./types.js";
import { TokenEstimator } from "./token-estimator.js";

const CONTEXT_AGENT_SYSTEM_PROMPT = `你是 Context Agent，负责管理对话上下文压缩。

当前状态：
- 当前压力：{pressure}%
- 需要释放：约 {targetFreeTokens} tokens（目标压力 {targetPressure}%）
- 保护区（最近 {protectRecent} 条消息）不可动

你拥有以下工具来执行压缩：
- exclude_messages: 从视图中排除指定消息（存储不变）
- snip_message: 对指定消息截断（保留头尾行）
- prune_tool_results: 将 tool_result 替换为元信息摘要
- summarize_range: 对指定范围生成摘要替换

压缩决策原则：
1. 已完成子任务的过程细节 → 优先压缩为结论
2. 同一文件的多次读取 → 只保留最新一次
3. 探索错误方向的对话 → 可以排除
4. bash 输出中的重复日志 → 截断保留头尾
5. 与当前任务直接相关的信息 → 尽量保留
6. 压缩量要足够让压力降到目标线以下

请分析下面的消息列表，选择合适的工具执行压缩。`;

const CONTEXT_AGENT_TOOLS = [
  {
    name: "exclude_messages",
    description: "从 API 视图中排除指定消息（存储层保留完整内容）。适用于已完全无用的旧消息。",
    input_schema: {
      type: "object",
      properties: {
        message_ids: {
          type: "array",
          items: { type: "string" },
          description: "要排除的消息 ID 列表",
        },
        reason: {
          type: "string",
          description: "排除原因（记录到遥测）",
        },
      },
      required: ["message_ids", "reason"],
    },
  },
  {
    name: "snip_message",
    description: "对指定消息做头尾截断，保留关键信息。适用于内容过长但仍有参考价值的消息。",
    input_schema: {
      type: "object",
      properties: {
        message_id: { type: "string", description: "目标消息 ID" },
        keep_head_lines: { type: "number", description: "保留头部行数" },
        keep_tail_lines: { type: "number", description: "保留尾部行数" },
      },
      required: ["message_id", "keep_head_lines", "keep_tail_lines"],
    },
  },
  {
    name: "prune_tool_results",
    description: "将指定 tool_result 替换为一行元信息摘要。适用于工具输出已过时的情况。",
    input_schema: {
      type: "object",
      properties: {
        message_ids: {
          type: "array",
          items: { type: "string" },
          description: "要裁剪的消息 ID 列表",
        },
      },
      required: ["message_ids"],
    },
  },
  {
    name: "summarize_range",
    description: "对指定范围的消息生成摘要，摘要替换原消息出现在视图中。适用于长段已完成的子任务。",
    input_schema: {
      type: "object",
      properties: {
        from_id: { type: "string", description: "范围起始消息 ID" },
        to_id: { type: "string", description: "范围结束消息 ID" },
      },
      required: ["from_id", "to_id"],
    },
  },
];

export interface ContextAgentAction {
  tool: string;
  input: Record<string, unknown>;
}

export async function invokeContextAgent(
  messages: ProviderMessage[],
  messageMetas: MessageMeta[],
  provider: Provider,
  config: ContextConfig,
  estimator: TokenEstimator
): Promise<AgentCompactionResult> {
  const startTime = Date.now();
  const pressureBefore = estimator.getPressure(messages, config);
  const targetFreeTokens = Math.ceil(
    (pressureBefore - config.compactTargetPressure) * config.contextWindow
  );

  const systemPrompt = CONTEXT_AGENT_SYSTEM_PROMPT
    .replace("{pressure}", (pressureBefore * 100).toFixed(0))
    .replace("{targetFreeTokens}", String(targetFreeTokens))
    .replace("{targetPressure}", (config.compactTargetPressure * 100).toFixed(0))
    .replace("{protectRecent}", String(config.protectRecent));

  const metaSummary = formatMessageMetas(messageMetas, config);

  const agentMessages: ProviderMessage[] = [
    {
      role: "user",
      content: [{ type: "text", text: metaSummary }],
    },
  ];

  const actions: ContextAgentAction[] = [];

  try {
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("context_agent_timeout")), config.contextAgentTimeout)
    );

    const agentPromise = runAgent(agentMessages, systemPrompt, provider);
    const agentActions = await Promise.race([agentPromise, timeoutPromise]);
    actions.push(...agentActions);
  } catch (err) {
    const reason = (err as Error).message === "context_agent_timeout" ? "timeout" : "llm_error";
    return {
      success: false,
      pressureBefore,
      pressureAfter: pressureBefore,
      actionsExecuted: [],
      duration: Date.now() - startTime,
      degradedToRule: true,
      degradeReason: reason,
    };
  }

  // 执行 actions，计算效果
  const executedActions: AgentCompactionResult["actionsExecuted"] = [];
  const excludedIds = new Set<string>();
  const snippedIds = new Set<string>();
  const prunedIds = new Set<string>();

  for (const action of actions) {
    switch (action.tool) {
      case "exclude_messages": {
        const ids = action.input.message_ids as string[];
        for (const id of ids) excludedIds.add(id);
        executedActions.push({ tool: "exclude_messages", messageIds: ids, freedChars: 0 });
        break;
      }
      case "snip_message": {
        const id = action.input.message_id as string;
        snippedIds.add(id);
        executedActions.push({ tool: "snip_message", messageIds: [id], freedChars: 0 });
        break;
      }
      case "prune_tool_results": {
        const ids = action.input.message_ids as string[];
        for (const id of ids) prunedIds.add(id);
        executedActions.push({ tool: "prune_tool_results", messageIds: ids, freedChars: 0 });
        break;
      }
      case "summarize_range": {
        const from = action.input.from_id as string;
        const to = action.input.to_id as string;
        executedActions.push({ tool: "summarize_range", messageIds: [from, to], freedChars: 0 });
        break;
      }
    }
  }

  // 效果评估：重新估算压力
  // 注意：实际压力下降需要在 context-manager 中执行完 actions 后重新计算
  const duration = Date.now() - startTime;

  return {
    success: actions.length > 0,
    pressureBefore,
    pressureAfter: pressureBefore, // 实际值由 context-manager 在执行后填充
    actionsExecuted: executedActions,
    duration,
    degradedToRule: false,
  };
}

async function runAgent(
  messages: ProviderMessage[],
  systemPrompt: string,
  provider: Provider
): Promise<ContextAgentAction[]> {
  const actions: ContextAgentAction[] = [];

  const stream = provider.stream(messages, {
    systemPrompt,
    tools: CONTEXT_AGENT_TOOLS,
    maxTokens: 2048,
  });

  for await (const event of stream) {
    if (event.type === "message_end") {
      for (const block of event.message.content) {
        if (block.type === "tool_use") {
          actions.push({
            tool: block.name,
            input: block.input as Record<string, unknown>,
          });
        }
      }
    }
  }

  return actions;
}

function formatMessageMetas(metas: MessageMeta[], config: ContextConfig): string {
  const protectFrom = metas.length - config.protectRecent;
  const lines: string[] = ["消息列表（从旧到新）：\n"];

  for (const meta of metas) {
    const protected_ = meta.index >= protectFrom ? " [保护区]" : "";
    const excluded = meta.excluded ? " [已排除]" : "";
    const tool = meta.toolName ? ` tool=${meta.toolName}` : "";
    lines.push(
      `  ${meta.id} | ${meta.role}/${meta.type}${tool} | ${meta.chars} chars (~${meta.estimatedTokens} tokens)${protected_}${excluded}`
    );
  }

  return lines.join("\n");
}

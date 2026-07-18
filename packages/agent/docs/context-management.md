# Context Window 管理 — 设计文档

## 概述

ProletCode 的上下文管理系统负责在有限的 context window（默认 128K tokens）内维持对话的连续性和可用性。系统采用"存储完整，视图裁剪"的核心策略——存储层保留所有原始消息，压缩仅发生在构建 API 请求视图时。

## 设计原则

1. **存储完整，视图裁剪** — 存储层 append-only，压缩只影响发给 API 的视图
2. **不做入库时压缩** — 唯一例外：安全阀截断（防单条爆内存）
3. **能力门控** — 根据 provider 能力决定可用策略（有 cache_edits → 开 Microcompact 路径 A）
4. **Context Agent 优先** — 压力压缩默认交由 Context Agent 做智能决策，降级为规则管线
5. **遥测驱动优化** — 每次压缩操作记录结构化数据，为未来自适应策略积累依据

## 参考项目

| 项目 | 借鉴内容 |
|------|----------|
| CodeWhale | PressureLevel 压力分级、本地裁剪策略、Agent-Driven Purge 理念 |
| Pi | 增量摘要（UPDATE_SUMMARIZATION_PROMPT）、结构化摘要格式 |
| Open-ClaudeCode | 双路径 microcompact、cache_edits 能力门控 |
| OpenCode | role 变异（摘要以 user role 注入）、指针不删 |
| OpenHands | 事件驱动 condenser、粒度排除 |
| rookie_agent | 四层压缩、混合 token 估算 |

## 架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        Agent Loop                                │
│                                                                  │
│  消息入队 ──→ onMessageAdded() ──→ Snip（安全阀）                │
│                                                                  │
│  每轮结束 ──→ onTurnEnd() ──→ Microcompact                      │
│                                                                  │
│  API 调用前 ──→ beforeApiCall() ──→ 压力检测                     │
│                                      │                           │
│                                      ├─ Context Agent（默认）    │
│                                      │    ├─ 有效 → 完成         │
│                                      │    └─ 无效 → 降级         │
│                                      │                           │
│                                      └─ Rule 管线（降级/禁用时） │
│                                           ├─ Prune              │
│                                           └─ Summarize          │
│                                                                  │
│  Overflow ──→ onOverflowError() ──→ Reactive → Collapse         │
└─────────────────────────────────────────────────────────────────┘
```

## 触发时机

### 时机 1：消息入队时（始终自动）

**Snip（安全阀）**

当 tool_result 内容超过 `snipCharThreshold`（默认 20000 chars）时，截断为头 N 行 + 尾 M 行，中间插入省略标记。保护区内的消息不处理。

- 触发条件：tool_result.content.length > snipCharThreshold
- 保护区：最近 `protectRecent`（默认 4）条消息不处理
- 截断方式：头 10 行 + `[省略 X 行]` + 尾 5 行

### 时机 2：每轮结束（能力门控）

**Microcompact**

清理保护区外已过时的 tool_result。双路径设计：

- **路径 A（cache 存活 + 支持 cache_edits）**：不修改存储，只标记 excludedIds。视图构建时用占位符替换。保护前缀缓存。
- **路径 B（cache 过期 或 不支持 cache_edits）**：直接在视图中替换为占位符。

路径选择：`Date.now() - lastAssistantTimestamp < cacheTTL` → 路径 A，否则路径 B。

保护最近 `microcompactKeep`（默认 4）条 tool_result。

### 时机 3：API 调用前（压力驱动）

当 token 估算 / contextWindow >= `compactThreshold`（默认 70%）时触发。

**默认路径：Context Agent**

唤醒一个子 LLM 调用，提供：
- 消息列表元数据（id、类型、工具名、字符数）
- 当前压力和目标
- 压缩工具集（exclude / snip / prune / summarize_range）
- 决策指导 system prompt

Agent 执行后评估效果：
- 有效（压力降至 compactThreshold 以下，或下降 >= 15%）→ 完成
- 无效 / 超时 / 错误 → 降级为 Rule 管线

**降级路径：Rule 管线**

- 压力 70-85%：Prune — 替换旧/重复 tool_result 为元信息行
- 压力 85%+：Summarize — 调 LLM 生成/更新增量摘要

### 时机 4：API overflow 后（始终自动）

- **Reactive**：激进 snip + critical 级全裁 + 增量摘要（保护区缩小到 10K tokens）
- **Collapse**：保留最后 2 条 + 一句话摘要，摘要以 user role 注入

## Context Agent 设计

### 工具集

| 工具 | 说明 | 适用场景 |
|------|------|----------|
| exclude_messages | 从视图中排除指定消息 | 已完全无用的旧消息 |
| snip_message | 对指定消息截断 | 内容过长但仍有参考价值 |
| prune_tool_results | 替换为一行元信息 | 工具输出已过时 |
| summarize_range | 对范围生成摘要替换 | 长段已完成子任务 |

### System Prompt 决策原则

1. 已完成子任务的过程细节 → 优先压缩为结论
2. 同一文件的多次读取 → 只保留最新一次
3. 探索错误方向的对话 → 可以排除
4. bash 输出中的重复日志 → 截断保留头尾
5. 与当前任务直接相关的信息 → 尽量保留
6. 压缩量要足够让压力降到目标线以下

### 效果评估与降级

```typescript
interface AgentCompactionResult {
  success: boolean;
  pressureBefore: number;
  pressureAfter: number;
  actionsExecuted: Array<{ tool: string; messageIds: string[]; freedChars: number }>;
  duration: number;
  degradedToRule: boolean;
  degradeReason?: "ineffective" | "timeout" | "llm_error";
}
```

评估标准：
- **有效**：压力 < compactThreshold 或下降 >= 15%
- **无效**：压力未有效下降
- **异常**：超时(10s) 或 LLM 错误

## Token 估算

混合模式：
- **精确值**：API 返回的 `usage.inputTokens`（每次成功调用后更新）
- **近似值**：新增消息用 chars/4（文本）或 chars/2（JSON）估算
- **压力计算**：estimatedTokens / contextWindow

## 配置项

```typescript
interface ContextConfig {
  // 安全阀
  snipCharThreshold: number;       // 20000
  snipHeadLines: number;           // 10
  snipTailLines: number;           // 5
  
  // Microcompact
  microcompactKeep: number;        // 4
  cacheTTL: number;                // 300000 (5min)
  
  // 压力压缩
  compactThreshold: number;        // 0.70
  compactTargetPressure: number;   // 0.50
  aggressiveThreshold: number;     // 0.85
  
  // Context Agent
  disableContextAgent: boolean;    // false（默认开启）
  contextAgentTimeout: number;     // 10000 (10s)
  
  // 通用
  keepRecentTokens: number;        // 20000
  reactiveKeepTokens: number;      // 10000
  protectRecent: number;           // 4
  contextWindow: number;           // 128000
}
```

## 遥测

每次压缩操作记录 `CompactionEvent`，追加到 `.proletcode/telemetry/context.jsonl`：

```typescript
interface CompactionEvent {
  timestamp: number;
  layer: "snip" | "microcompact" | "prune" | "summarize" | "context_agent" | "reactive" | "collapse";
  trigger: "entry" | "turn_end" | "pressure" | "overflow";
  before: { messageCount; tokenEstimate; toolResultCount };
  after: { messageCount; tokenEstimate; toolResultCount };
  affected: Array<{ type; toolName?; originalChars; resultChars }>;
  llmCallMade: boolean;
  llmInputTokens?: number;
  llmOutputTokens?: number;
  pressure: { before: PressureLevel; after: PressureLevel };
  freedTokens: number;
  duration: number;
  agentResult?: AgentCompactionResult;
}
```

数据用途：
- 分析哪类 tool_result 最占空间 → 调整 snip 阈值
- 统计 Context Agent 成功率 → 优化 system prompt
- Agent 降级频率 → 决定是否默认禁用
- 追踪 LLM 摘要成本占比 → 成本优化决策

## 文件结构

```
packages/agent/src/context/
├── types.ts              # 类型定义 + 默认配置
├── token-estimator.ts    # 混合 token 估算
├── snip.ts               # 时机1: 安全阀截断
├── microcompact.ts       # 时机2: 每轮预防性清理
├── prune.ts              # 时机3 Rule: 本地裁剪
├── summarize.ts          # 时机3 Rule: 增量摘要
├── context-agent.ts      # 时机3 Agent: 子 LLM 调用
├── reactive.ts           # 时机4: overflow 应急
├── collapse.ts           # 时机4: 最后手段
├── telemetry.ts          # 压缩遥测
├── context-manager.ts    # 统一管理器
└── index.ts              # 导出
```

## 集成点

在 `agent-loop.ts` 中：

```typescript
// 创建
const contextManager = new ContextManager({ provider, config, capabilities });

// 时机 1：消息入队
messages = contextManager.onMessageAdded(messages);

// 时机 2：每轮结束
messages = contextManager.onTurnEnd(messages);

// 时机 3：API 调用前
const viewMessages = await contextManager.beforeApiCall(messages);
provider.stream(viewMessages, ...);

// 时机 4：overflow
messages = await contextManager.onOverflowError(messages);

// 成功后更新基线
contextManager.onApiSuccess(usage.inputTokens, messages.length);
```

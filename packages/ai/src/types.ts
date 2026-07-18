// ============================================================
// Content Blocks — LLM 消息内容块
// ============================================================

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock;

// ============================================================
// Messages
// ============================================================

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";

export interface UserMessage {
  role: "user";
  content: string | ContentBlock[];
}

export interface AssistantMessage {
  role: "assistant";
  content: ContentBlock[];
  stopReason: StopReason;
}

export type Message = UserMessage | AssistantMessage;

// ============================================================
// Provider 接口
// ============================================================

export interface Provider {
  stream(messages: ProviderMessage[], options: StreamOptions): AsyncGenerator<StreamEvent>;
}

export interface StreamOptions {
  systemPrompt: string;
  tools: ToolDefinition[];
  maxTokens: number;
  signal?: AbortSignal;
}

// ============================================================
// Provider 层消息格式
// ============================================================

export type ProviderMessage =
  | { role: "user"; content: string | ProviderContentBlock[] }
  | { role: "assistant"; content: ProviderContentBlock[] };

export type ProviderContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

// ============================================================
// Tool Definition — 发送给 LLM 的工具描述
// ============================================================

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

// ============================================================
// Stream Events
// ============================================================

export type StreamEvent =
  | { type: "message_start" }
  | { type: "thinking_delta"; delta: string }
  | { type: "text_delta"; delta: string }
  | { type: "tool_use_start"; index: number; id: string; name: string }
  | { type: "tool_use_delta"; index: number; delta: string }
  | { type: "tool_use_end"; index: number }
  | { type: "message_end"; message: AssistantMessage };

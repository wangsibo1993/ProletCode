import type { StopReason } from "@proletcode/ai";

// ============================================================
// Agent Events — agent loop 向外部报告的事件流
// ============================================================

export interface ToolUseResult {
  content: string;
  isError: boolean;
}

export type AgentEvent =
  | { type: "turn_start" }
  | { type: "thinking_delta"; delta: string }
  | { type: "text_delta"; delta: string }
  | { type: "tool_use_start"; name: string; id: string; input: Record<string, unknown> }
  | { type: "tool_use_end"; name: string; id: string; result: ToolUseResult }
  | { type: "turn_end"; stopReason: StopReason }
  | { type: "error"; error: Error };

// ============================================================
// Terminal — agent loop 结束原因
// ============================================================

export type Terminal =
  | { reason: "completed" }
  | { reason: "max_turns" }
  | { reason: "aborted" }
  | { reason: "error"; error: Error };

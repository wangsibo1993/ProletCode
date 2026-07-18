import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { PressureLevel, AgentCompactionResult } from "./types.js";

export interface CompactionEvent {
  timestamp: number;
  layer: "snip" | "microcompact" | "prune" | "summarize" | "context_agent" | "reactive" | "collapse";
  trigger: "entry" | "turn_end" | "pressure" | "overflow";

  before: { messageCount: number; tokenEstimate: number; toolResultCount: number };
  after: { messageCount: number; tokenEstimate: number; toolResultCount: number };

  affected: Array<{
    type: "tool_result" | "text" | "thinking";
    toolName?: string;
    originalChars: number;
    resultChars: number;
  }>;

  llmCallMade: boolean;
  llmInputTokens?: number;
  llmOutputTokens?: number;

  pressure: { before: PressureLevel; after: PressureLevel };
  freedTokens: number;
  duration: number;

  // Context Agent 专属字段
  agentResult?: AgentCompactionResult;
}

export class ContextTelemetry {
  private events: CompactionEvent[] = [];
  private baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? join(process.cwd(), ".proletcode", "telemetry");
  }

  record(event: CompactionEvent): void {
    this.events.push(event);
  }

  recordAgentResult(result: AgentCompactionResult): void {
    this.record({
      timestamp: Date.now(),
      layer: "context_agent",
      trigger: "pressure",
      before: { messageCount: 0, tokenEstimate: 0, toolResultCount: 0 },
      after: { messageCount: 0, tokenEstimate: 0, toolResultCount: 0 },
      affected: [],
      llmCallMade: true,
      pressure: { before: "high", after: result.success ? "medium" : "high" },
      freedTokens: 0,
      duration: result.duration,
      agentResult: result,
    });
  }

  getEvents(): CompactionEvent[] {
    return [...this.events];
  }

  getSummary(): {
    totalCompactions: number;
    avgFreedTokens: number;
    llmCalls: number;
    agentInvocations: number;
    agentDegradations: number;
    totalDuration: number;
  } {
    const llmCalls = this.events.filter((e) => e.llmCallMade).length;
    const agentEvents = this.events.filter((e) => e.layer === "context_agent");
    const agentDegradations = agentEvents.filter(
      (e) => e.agentResult?.degradedToRule
    ).length;
    const totalFreed = this.events.reduce((sum, e) => sum + e.freedTokens, 0);
    const totalDuration = this.events.reduce((sum, e) => sum + e.duration, 0);

    return {
      totalCompactions: this.events.length,
      avgFreedTokens: this.events.length > 0 ? totalFreed / this.events.length : 0,
      llmCalls,
      agentInvocations: agentEvents.length,
      agentDegradations,
      totalDuration,
    };
  }

  async flush(): Promise<void> {
    if (this.events.length === 0) return;

    await mkdir(this.baseDir, { recursive: true });
    const filePath = join(this.baseDir, "context.jsonl");
    const lines = this.events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await writeFile(filePath, lines, { flag: "a" });
    this.events = [];
  }
}

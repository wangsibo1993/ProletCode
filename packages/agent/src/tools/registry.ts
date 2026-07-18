import type { ToolDefinition } from "@proletcode/ai";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { zodToJsonSchema } from "./schema-utils.js";

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  getDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: zodToJsonSchema(tool.inputSchema),
    }));
  }

  async execute(name: string, input: unknown, context: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { content: `未知工具: ${name}`, isError: true };
    }

    const parsed = tool.inputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        content: `参数无效: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
        isError: true,
      };
    }

    try {
      return await tool.execute(parsed.data, context);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: `工具执行错误: ${message}`, isError: true };
    }
  }
}

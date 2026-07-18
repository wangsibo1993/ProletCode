import { z } from "zod";
import { writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { buildTool } from "@proletcode/agent";
import type { ToolContext, ToolResult } from "@proletcode/agent";

const inputSchema = z.object({
  path: z.string().describe("文件路径（相对于工作目录或绝对路径）"),
  content: z.string().describe("要写入的完整文件内容"),
});

export const writeFileTool = buildTool({
  name: "write_file",
  description: "创建或覆盖文件。如果目录不存在会自动创建。",
  inputSchema,

  async execute(input, context: ToolContext): Promise<ToolResult> {
    const filePath = resolve(context.cwd, input.path);

    try {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, input.content, "utf-8");
      return { content: `已写入: ${filePath}`, isError: false };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `写入失败: ${msg}`, isError: true };
    }
  },
});

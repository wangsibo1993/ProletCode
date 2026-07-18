import { z } from "zod";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildTool } from "@proletcode/agent";
import type { ToolContext, ToolResult } from "@proletcode/agent";

const inputSchema = z.object({
  path: z.string().describe("文件路径（相对于工作目录或绝对路径）"),
  offset: z.number().optional().describe("起始行号（从 1 开始）"),
  limit: z.number().optional().describe("读取的最大行数"),
});

export const readFileTool = buildTool({
  name: "read_file",
  description: "读取文件内容，返回带行号的文本。支持 offset/limit 分段读取大文件。",
  inputSchema,
  isReadOnly: true,
  isConcurrencySafe: true,

  async execute(input, context: ToolContext): Promise<ToolResult> {
    const filePath = resolve(context.cwd, input.path);

    try {
      const raw = await readFile(filePath, "utf-8");
      const lines = raw.split("\n");

      const offset = (input.offset ?? 1) - 1;
      const limit = input.limit ?? lines.length;
      const slice = lines.slice(offset, offset + limit);

      const numbered = slice
        .map((line, i) => `${offset + i + 1}\t${line}`)
        .join("\n");

      return { content: numbered, isError: false };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `读取失败: ${msg}`, isError: true };
    }
  },
});

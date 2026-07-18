import { z } from "zod";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildTool } from "@proletcode/agent";
import type { ToolContext, ToolResult } from "@proletcode/agent";

const inputSchema = z.object({
  path: z.string().describe("文件路径"),
  old_text: z.string().describe("要被替换的原始文本（必须唯一匹配）"),
  new_text: z.string().describe("替换后的新文本"),
});

export const editFileTool = buildTool({
  name: "edit_file",
  description: "通过搜索替换精确修改文件内容。old_text 必须在文件中唯一匹配。",
  inputSchema,

  async execute(input, context: ToolContext): Promise<ToolResult> {
    const filePath = resolve(context.cwd, input.path);

    try {
      const content = await readFile(filePath, "utf-8");

      const occurrences = content.split(input.old_text).length - 1;
      if (occurrences === 0) {
        return { content: "未找到匹配文本", isError: true };
      }
      if (occurrences > 1) {
        return { content: `匹配了 ${occurrences} 处，需要唯一匹配。请提供更多上下文。`, isError: true };
      }

      const updated = content.replace(input.old_text, input.new_text);
      await writeFile(filePath, updated, "utf-8");

      return { content: `已修改: ${filePath}`, isError: false };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `编辑失败: ${msg}`, isError: true };
    }
  },
});

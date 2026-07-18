import { z } from "zod";
import { spawn } from "node:child_process";
import { buildTool } from "@proletcode/agent";
import type { ToolContext, ToolResult } from "@proletcode/agent";

const inputSchema = z.object({
  command: z.string().describe("要执行的 shell 命令"),
  timeout: z.number().optional().describe("超时时间（毫秒），默认 30000"),
});

const MAX_OUTPUT = 100_000;

export const bashTool = buildTool({
  name: "bash",
  description: "执行 shell 命令并返回输出。默认超时 30 秒。",
  inputSchema,

  async execute(input, context: ToolContext): Promise<ToolResult> {
    const timeout = input.timeout ?? 30_000;

    return new Promise<ToolResult>((resolvePromise) => {
      const child = spawn("sh", ["-c", input.command], {
        cwd: context.cwd,
        env: process.env,
        signal: context.signal,
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        if (stdout.length > MAX_OUTPUT) {
          stdout = stdout.slice(0, MAX_OUTPUT) + "\n...[输出已截断]";
          child.kill();
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
        if (stderr.length > MAX_OUTPUT) {
          stderr = stderr.slice(0, MAX_OUTPUT) + "\n...[输出已截断]";
          child.kill();
        }
      });

      const timer = setTimeout(() => {
        child.kill();
        resolvePromise({ content: "命令超时", isError: true });
      }, timeout);

      child.on("close", (code) => {
        clearTimeout(timer);
        const output = [
          stdout ? `stdout:\n${stdout}` : "",
          stderr ? `stderr:\n${stderr}` : "",
          `exit code: ${code}`,
        ]
          .filter(Boolean)
          .join("\n\n");

        resolvePromise({ content: output, isError: code !== 0 });
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        resolvePromise({ content: `执行失败: ${err.message}`, isError: true });
      });
    });
  },
});

import * as readline from "node:readline";
import chalk from "chalk";
import { createMiniMaxProvider } from "@proletcode/ai";
import { agentLoop } from "@proletcode/agent";
import type { ProviderMessage } from "@proletcode/ai";
import { loadConfig } from "./config.js";
import { SYSTEM_PROMPT } from "./system-prompt.js";
import { createToolRegistry } from "./tools/index.js";

const config = loadConfig();

const provider = createMiniMaxProvider({
  apiKey: config.apiKey,
  baseURL: config.baseURL,
  model: config.model,
});

const registry = createToolRegistry();
const messages: ProviderMessage[] = [];

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

console.log(chalk.bold.green("ProletCode 编程助手"));
console.log(chalk.gray("输入你的问题，Ctrl+C 退出\n"));

function prompt() {
  rl.question(chalk.blue("> "), async (input) => {
    const trimmed = input.trim();
    if (!trimmed) {
      prompt();
      return;
    }

    messages.push({ role: "user", content: [{ type: "text", text: trimmed }] });

    const abortController = new AbortController();

    const handleSigint = () => {
      abortController.abort();
      console.log(chalk.yellow("\n已中断"));
    };
    process.on("SIGINT", handleSigint);

    try {
      const loop = agentLoop({
        provider,
        registry,
        messages,
        systemPrompt: SYSTEM_PROMPT,
        tools: registry.getDefinitions(),
        maxTurns: 10,
        signal: abortController.signal,
        cwd: process.cwd(),
      });

      for await (const event of loop) {
        switch (event.type) {
          case "thinking_delta":
            process.stdout.write(chalk.gray(event.delta));
            break;
          case "text_delta":
            process.stdout.write(event.delta);
            break;
          case "tool_use_start":
            console.log(chalk.cyan(`\n[调用工具: ${event.name}]`));
            break;
          case "tool_use_end":
            if (event.result.isError) {
              console.log(chalk.red(`[工具错误: ${event.result.content}]`));
            } else {
              const preview = event.result.content.slice(0, 200);
              console.log(chalk.gray(`[工具结果: ${preview}${event.result.content.length > 200 ? "..." : ""}]`));
            }
            break;
          case "error":
            console.log(chalk.red(`\n错误: ${event.error.message}`));
            break;
          case "turn_end":
            console.log();
            break;
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        console.error(chalk.red(`\n运行错误: ${(err as Error).message}`));
      }
    } finally {
      process.off("SIGINT", handleSigint);
    }

    console.log();
    prompt();
  });
}

prompt();

import * as readline from "node:readline";
import { join } from "node:path";
import { unlink } from "node:fs/promises";
import chalk from "chalk";
import { createMiniMaxProvider } from "@proletcode/ai";
import { agentLoop, FileSessionStorage, buildConversationChain } from "@proletcode/agent";
import type { ProviderMessage } from "@proletcode/ai";
import type { SerializedContextState, SessionEntry } from "@proletcode/agent";
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

// ─── Session ───

const SESSION_DIR = join(process.cwd(), ".proletcode", "sessions");
const SESSION_FILE = join(SESSION_DIR, "current.jsonl");

let storage = new FileSessionStorage(SESSION_FILE);
let messages: ProviderMessage[] = [];
let contextState: SerializedContextState | undefined;
let leafId: string | null = null;

async function startNewSession(): Promise<void> {
  // 清除旧会话文件
  try { await unlink(SESSION_FILE); } catch { /* 不存在则忽略 */ }
  storage = new FileSessionStorage(SESSION_FILE);
  messages = [];
  contextState = undefined;
  leafId = null;
  await storage.create({ cwd: process.cwd(), model: config.model });
}

async function resumeSession(): Promise<boolean> {
  if (!(await storage.exists())) return false;

  const entries = await storage.readAll();
  const chain = buildConversationChain(entries);

  if (chain.messages.length === 0) return false;

  messages = chain.messages;
  leafId = chain.leafId;
  contextState = chain.contextState ?? undefined;

  const header = entries.find((e) => e.type === "session_header");
  const age = header && "createdAt" in header
    ? (Date.now() - header.createdAt) / 3600_000
    : 0;

  console.log(
    chalk.green(`[已恢复会话: ${messages.length} 条消息, ${age < 1 ? `${Math.round(age * 60)}分钟前` : `${Math.round(age)}小时前`}]`)
  );

  // 回显历史对话摘要
  for (const msg of messages) {
    if (msg.role === "user") {
      const text = typeof msg.content === "string"
        ? msg.content
        : msg.content.find((b) => b.type === "text")?.text ?? "";
      if (text) console.log(chalk.blue(`  > ${text.length > 80 ? text.slice(0, 80) + "..." : text}`));
    } else {
      const text = msg.content.find((b) => b.type === "text")?.text ?? "";
      if (text) console.log(chalk.gray(`  ${text.length > 80 ? text.slice(0, 80) + "..." : text}`));
    }
  }
  console.log();

  return true;
}

// ─── REPL ───

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function question(prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

async function main() {
  console.log(chalk.bold.green("ProletCode 编程助手"));

  // 启动时检查是否有上次会话
  if (await storage.exists()) {
    const answer = await question(chalk.yellow("检测到上次会话，是否恢复？(y/n) "));
    if (answer.trim().toLowerCase() === "y") {
      await resumeSession();
    } else {
      await startNewSession();
    }
  } else {
    await startNewSession();
  }

  console.log(chalk.gray("输入问题开始对话，/resume 恢复上次会话，/new 新建会话，Ctrl+C 退出\n"));

  prompt();
}

function prompt() {
  rl.question(chalk.blue("> "), async (input) => {
    const trimmed = input.trim();
    if (!trimmed) {
      prompt();
      return;
    }

    // 斜杠命令
    if (trimmed === "/resume") {
      const ok = await resumeSession();
      if (!ok) console.log(chalk.yellow("没有可恢复的会话"));
      prompt();
      return;
    }
    if (trimmed === "/new") {
      await startNewSession();
      console.log(chalk.green("[已新建会话]"));
      prompt();
      return;
    }

    // 持久化用户消息
    const userMessage: ProviderMessage = { role: "user", content: [{ type: "text", text: trimmed }] };
    const userEntryId = crypto.randomUUID();
    await storage.append({
      type: "user",
      id: userEntryId,
      parentId: leafId,
      timestamp: Date.now(),
      message: userMessage,
    });
    leafId = userEntryId;

    messages.push(userMessage);

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
        contextState,
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
          case "message_appended": {
            const entryId = crypto.randomUUID();
            await storage.append({
              type: event.role,
              id: entryId,
              parentId: leafId!,
              timestamp: Date.now(),
              message: event.message,
            } as SessionEntry);
            leafId = entryId;
            break;
          }
          case "context_state_changed":
            contextState = event.state;
            await storage.append({
              type: "context_state",
              id: crypto.randomUUID(),
              parentId: leafId!,
              timestamp: Date.now(),
              state: event.state,
            });
            break;
          case "compaction_occurred": {
            const compactionId = crypto.randomUUID();
            await storage.append({
              type: "compaction",
              id: compactionId,
              parentId: leafId!,
              timestamp: Date.now(),
              record: event.record,
              summaryMessage: event.summaryMessage,
              compactedEntryIds: [],
            });
            leafId = compactionId;
            break;
          }
        }
      }

      // turn 完成后写 leaf pointer
      await storage.append({
        type: "leaf",
        id: crypto.randomUUID(),
        leafId: leafId!,
        timestamp: Date.now(),
      });
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

// ─── 优雅退出 ───

async function gracefulShutdown() {
  if (leafId) {
    await storage.append({
      type: "leaf",
      id: crypto.randomUUID(),
      leafId,
      timestamp: Date.now(),
    });
  }
  process.exit(0);
}

process.on("SIGTERM", gracefulShutdown);

main().catch((err) => {
  console.error(chalk.red(`启动失败: ${err.message}`));
  process.exit(1);
});

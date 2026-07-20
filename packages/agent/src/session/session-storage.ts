import { readFile, appendFile, mkdir, access } from "node:fs/promises";
import { dirname } from "node:path";
import type { SessionHeader, SessionEntry, LeafEntry } from "./types.js";

// ============================================================
// SessionStorage 接口
// ============================================================

export interface SessionStorage {
  create(opts: { cwd: string; model?: string }): Promise<string>;
  append(entry: SessionEntry): Promise<void>;
  appendBatch(entries: SessionEntry[]): Promise<void>;
  readAll(): Promise<SessionEntry[]>;
  readHeader(): Promise<SessionHeader | null>;
  getLeaf(): Promise<LeafEntry | null>;
  exists(): Promise<boolean>;
  getPath(): string;
}

// ============================================================
// FileSessionStorage — JSONL 文件实现
// ============================================================

export class FileSessionStorage implements SessionStorage {
  constructor(private filePath: string) {}

  async create(opts: { cwd: string; model?: string }): Promise<string> {
    const sessionId = crypto.randomUUID();
    const header: SessionHeader = {
      type: "session_header",
      sessionId,
      version: 1,
      createdAt: Date.now(),
      cwd: opts.cwd,
      model: opts.model,
    };
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, JSON.stringify(header) + "\n", "utf-8");
    return sessionId;
  }

  async append(entry: SessionEntry): Promise<void> {
    await appendFile(this.filePath, JSON.stringify(entry) + "\n", "utf-8");
  }

  async appendBatch(entries: SessionEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const lines = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await appendFile(this.filePath, lines, "utf-8");
  }

  async readAll(): Promise<SessionEntry[]> {
    let content: string;
    try {
      content = await readFile(this.filePath, "utf-8");
    } catch {
      return [];
    }

    const entries: SessionEntry[] = [];
    const lines = content.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed) as SessionEntry);
      } catch {
        // 崩溃中断的不完整行，跳过
        continue;
      }
    }
    return entries;
  }

  async readHeader(): Promise<SessionHeader | null> {
    let content: string;
    try {
      content = await readFile(this.filePath, "utf-8");
    } catch {
      return null;
    }
    const firstNewline = content.indexOf("\n");
    const firstLine = firstNewline === -1 ? content : content.slice(0, firstNewline);
    try {
      const parsed = JSON.parse(firstLine.trim());
      if (parsed.type === "session_header") return parsed as SessionHeader;
    } catch {
      // ignore
    }
    return null;
  }

  async getLeaf(): Promise<LeafEntry | null> {
    const entries = await this.readAll();
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].type === "leaf") return entries[i] as LeafEntry;
    }
    return null;
  }

  async exists(): Promise<boolean> {
    try {
      await access(this.filePath);
      return true;
    } catch {
      return false;
    }
  }

  getPath(): string {
    return this.filePath;
  }
}

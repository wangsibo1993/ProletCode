import type { z } from "zod";

export interface Tool<TInput = any, TOutput = any> {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  isReadOnly: boolean;
  isConcurrencySafe: boolean;
  execute(input: TInput, context: ToolContext): Promise<ToolResult<TOutput>>;
}

export interface ToolContext {
  cwd: string;
  signal: AbortSignal;
}

export interface ToolResult<T = string> {
  content: string;
  isError: boolean;
  data?: T;
}

export interface ToolDef<TInput = any, TOutput = any> {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  isReadOnly?: boolean;
  isConcurrencySafe?: boolean;
  execute(input: TInput, context: ToolContext): Promise<ToolResult<TOutput>>;
}

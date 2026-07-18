import type { Tool, ToolDef } from "./types.js";

export function buildTool<TInput, TOutput>(def: ToolDef<TInput, TOutput>): Tool<TInput, TOutput> {
  return {
    isReadOnly: false,
    isConcurrencySafe: false,
    ...def,
  };
}

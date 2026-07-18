import "dotenv/config";

export interface CodingAgentConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  maxTokens: number;
  contextWindow: number;
}

export function loadConfig(): CodingAgentConfig {
  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) {
    console.error("错误: 请设置环境变量 MINIMAX_API_KEY");
    process.exit(1);
  }

  return {
    apiKey,
    baseURL: "https://api.minimaxi.com/anthropic",
    model: "MiniMax-M3",
    maxTokens: 8192,
    contextWindow: 128_000,
  };
}

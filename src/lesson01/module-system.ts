export type ProviderName = "openai" | "anthropic" | "gemini" | "mistral";

export interface ModelRuntimeConfig {
  provider: ProviderName;
  modelId: string;
  temperature: number;
  maxOutputTokens: number;
}

export const DEFAULT_MODEL_CONFIG: ModelRuntimeConfig = {
  provider: "openai",
  modelId: "gpt-4o",
  temperature: 0.2,
  maxOutputTokens: 2048,
};

export function buildProviderUrl(provider: ProviderName, path: `/${string}`): string {
  if (path === "/") {
    throw new Error("Path must contain at least one segment");
  }
  const baseByProvider: Record<ProviderName, string> = {
    openai: "https://api.openai.com/v1",
    anthropic: "https://api.anthropic.com/v1",
    gemini: "https://generativelanguage.googleapis.com/v1",
    mistral: "https://api.mistral.ai/v1",
  };
  return `${baseByProvider[provider]}${path}`;
}

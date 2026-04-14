/**
 * Bài 1: TypeScript Advanced Types & AI Foundation
 * ===================================================
 * Chạy: npm run lesson01
 *
 * Nội dung:
 *  - Conditional Types & Infer
 *  - Template Literal Types
 *  - Branded / Nominal Types
 *  - Mapped Types + satisfies
 *  - Type-safe LLM client skeleton
 */

// ─────────────────────────────────────────────────────────────────────────────
// 1. CONDITIONAL TYPES & INFER
// ─────────────────────────────────────────────────────────────────────────────

type LLMMode = "stream" | "complete";

interface TextChunk {
  id: string;
  delta: string;
  finishReason: "stop" | "length" | "tool_call" | null;
}

interface CompletionResponse {
  id: string;
  content: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  finishReason: "stop" | "length" | "tool_call";
}

// LLMResponse<"stream"> → AsyncIterable<TextChunk>
// LLMResponse<"complete"> → CompletionResponse
type LLMResponse<M extends LLMMode> = M extends "stream"
  ? AsyncIterable<TextChunk>
  : CompletionResponse;

// Utility: unwrap the element type of an AsyncIterable
type AsyncIterableItem<T> = T extends AsyncIterable<infer Item> ? Item : never;

// Should be TextChunk ✓
type _StreamItem = AsyncIterableItem<LLMResponse<"stream">>;

// ─────────────────────────────────────────────────────────────────────────────
// 2. BRANDED / NOMINAL TYPES  (prevent mixing up raw strings/numbers)
// ─────────────────────────────────────────────────────────────────────────────

declare const brand: unique symbol;

type Brand<T, B extends string> = T & { readonly [brand]: B };

type UserId   = Brand<string, "UserId">;
type ModelId  = Brand<string, "ModelId">;
type Token    = Brand<number, "Token">;
type EmbeddingVector = Brand<readonly number[], "EmbeddingVector">;

// Constructor helpers enforce creation at the boundary
function userId(raw: string): UserId {
  if (!raw.startsWith("usr_")) throw new Error(`Invalid UserId: ${raw}`);
  return raw as UserId;
}
function modelId(raw: string): ModelId { return raw as ModelId; }
function tokenCount(n: number): Token  { return n as Token; }
function embeddingVector(arr: readonly number[]): EmbeddingVector {
  return arr as EmbeddingVector;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. TEMPLATE LITERAL TYPES  (type-safe routing/event names)
// ─────────────────────────────────────────────────────────────────────────────

type HTTPMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
type APIVersion = "v1" | "v2" | "v3";

type EndpointId = `${HTTPMethod} /${APIVersion}/${string}`;

// EventEmitter event names for AI pipelines
type AIEvent =
  | `llm:${"start" | "token" | "end" | "error"}`
  | `agent:${"think" | "act" | "observe" | "done"}`
  | `rag:${"retrieve" | "rank" | "generate"}`;

// ─────────────────────────────────────────────────────────────────────────────
// 4. MAPPED TYPES + satisfies
// ─────────────────────────────────────────────────────────────────────────────

interface ProviderConfig {
  endpoint: string;
  maxTokens: number;
  supportsStreaming: boolean;
  supportsTools: boolean;
}

// Create a deep-readonly version of every key
type DeepReadonly<T> = { readonly [K in keyof T]: T[K] };

type SupportedProvider = "openai" | "anthropic" | "gemini" | "mistral";

// satisfies ensures values match ProviderConfig while keeping literal types
const PROVIDER_CONFIGS = {
  openai:    { endpoint: "https://api.openai.com/v1",        maxTokens: 128_000, supportsStreaming: true,  supportsTools: true  },
  anthropic: { endpoint: "https://api.anthropic.com/v1",     maxTokens: 200_000, supportsStreaming: true,  supportsTools: true  },
  gemini:    { endpoint: "https://generativelanguage.googleapis.com/v1", maxTokens: 1_000_000, supportsStreaming: true, supportsTools: true },
  mistral:   { endpoint: "https://api.mistral.ai/v1",        maxTokens: 32_000,  supportsStreaming: true,  supportsTools: false },
} satisfies Record<SupportedProvider, ProviderConfig>;

// ─────────────────────────────────────────────────────────────────────────────
// 5. TYPE-SAFE LLM CLIENT SKELETON
// ─────────────────────────────────────────────────────────────────────────────

interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
}

interface LLMRequestOptions {
  model: ModelId;
  messages: Message[];
  temperature?: number;
  maxTokens?: number;
  tools?: ToolDefinition[];
}

interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

// Overloaded signatures give correct return types based on mode
interface LLMClient {
  complete(opts: LLMRequestOptions & { stream: false }): Promise<CompletionResponse>;
  complete(opts: LLMRequestOptions & { stream: true }):  Promise<AsyncIterable<TextChunk>>;
  complete(opts: LLMRequestOptions & { stream: boolean }): Promise<CompletionResponse | AsyncIterable<TextChunk>>;
}

// In-memory mock implementation (no real HTTP needed to run this file)
class MockLLMClient implements LLMClient {
  private readonly provider: SupportedProvider;

  constructor(provider: SupportedProvider) {
    this.provider = provider;
    console.log(`[LLMClient] Initialized with provider: ${provider}`);
    console.log(`[LLMClient] Config:`, PROVIDER_CONFIGS[provider]);
  }

  complete(opts: LLMRequestOptions & { stream: false }): Promise<CompletionResponse>;
  complete(opts: LLMRequestOptions & { stream: true }): Promise<AsyncIterable<TextChunk>>;
  complete(opts: LLMRequestOptions & { stream: boolean }): Promise<CompletionResponse | AsyncIterable<TextChunk>>;
  async complete(opts: LLMRequestOptions & { stream: boolean }): Promise<CompletionResponse | AsyncIterable<TextChunk>> {
    const echo = opts.messages.at(-1)?.content ?? "";
    if (opts.stream) return this.#stream(echo);
    return {
      id: `cmpl_${Date.now()}`,
      content: `[${this.provider}] Echo: ${echo}`,
      usage: { promptTokens: tokenCount(100), completionTokens: tokenCount(50), totalTokens: tokenCount(150) },
      finishReason: "stop",
    };
  }

  async *#stream(echo: string): AsyncIterable<TextChunk> {
    const words = `[${this.provider}] Streaming: ${echo}`.split(" ");
    for (const word of words) {
      await new Promise(r => setTimeout(r, 20));
      yield { id: `chunk_${Date.now()}`, delta: word + " ", finishReason: null };
    }
    yield { id: `chunk_${Date.now()}`, delta: "", finishReason: "stop" };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DEMO / RUN
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n══════════════════════════════════════");
  console.log(" Bài 1: Advanced Types & AI Foundation");
  console.log("══════════════════════════════════════\n");

  // Branded types demo
  const uid   = userId("usr_abc123");
  const model = modelId("gpt-4o");
  const vec   = embeddingVector([0.1, 0.2, 0.3]);
  console.log("Branded UserId:", uid);
  console.log("Branded ModelId:", model);
  console.log("Embedding vector length:", vec.length);

  // LLM client demo (non-streaming)
  const client = new MockLLMClient("openai");

  const response = await client.complete({
    model,
    messages: [{ role: "user", content: "Hello, TypeScript AI!" }],
    stream: false,
  });
  console.log("\n[Non-streaming response]:", response);

  // LLM client demo (streaming)
  console.log("\n[Streaming response]:");
  const stream = await client.complete({
    model,
    messages: [{ role: "user", content: "Stream this message" }],
    stream: true,
  });
  process.stdout.write("  > ");
  for await (const chunk of stream) {
    if (chunk.delta) process.stdout.write(chunk.delta);
  }
  console.log("\n\n[Provider configs]:");
  (Object.keys(PROVIDER_CONFIGS) as SupportedProvider[]).forEach(p => {
    const cfg = PROVIDER_CONFIGS[p];
    console.log(`  ${p.padEnd(10)} maxTokens=${cfg.maxTokens.toLocaleString()} streaming=${cfg.supportsStreaming} tools=${cfg.supportsTools}`);
  });

  console.log("\n✅ Bài 1 hoàn thành!\n");
}

main().catch(console.error);

export {};

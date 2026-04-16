/**
 * Bài 1: TypeScript Advanced Types & AI Foundation
 * ===================================================
 * Chạy: npm run lesson01
 *
 * Nội dung:
 *  - Conditional Types & Infer
 *  - Branded / Nominal Types
 *  - Template Literal Types & Prompt Templates
 *  - Mapped Types + satisfies
 *  - Discriminated Unions & State Machine
 *  - Function Overloads & Pipe
 *  - Type-safe LLM client skeleton
 *  - Typed Event Emitter
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
type ConversationId = Brand<string, "ConversationId">;
type MessageId = Brand<string, "MessageId">;
type Token    = Brand<number, "Token">;
type EmbeddingVector = Brand<readonly number[], "EmbeddingVector">;

// Constructor helpers enforce creation at the boundary
function userId(raw: string): UserId {
  if (!raw.startsWith("usr_")) throw new Error(`Invalid UserId: ${raw}`);
  return raw as UserId;
}
function modelId(raw: string): ModelId { return raw as ModelId; }
function conversationId(raw: string): ConversationId { return raw as ConversationId; }
function messageId(raw: string): MessageId { return raw as MessageId; }
function tokenCount(n: number): Token  { return n as Token; }
function embeddingVector(arr: readonly number[]): EmbeddingVector {
  return arr as EmbeddingVector;
}

// Cosine similarity between two embedding vectors
function cosineSimilarity(a: EmbeddingVector, b: EmbeddingVector): number {
  if (a.length !== b.length) {
    throw new Error(`Dimension mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. TEMPLATE LITERAL TYPES  (type-safe routing/event names/prompts)
// ─────────────────────────────────────────────────────────────────────────────

type HTTPMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
type APIVersion = "v1" | "v2" | "v3";

type EndpointId = `${HTTPMethod} /${APIVersion}/${string}`;

// EventEmitter event names for AI pipelines
type AIEvent =
  | `llm:${"start" | "token" | "end" | "error"}`
  | `agent:${"think" | "act" | "observe" | "done"}`
  | `rag:${"retrieve" | "rank" | "generate"}`;

// Extract variables from template literal strings
type ExtractVariables<T extends string> =
  T extends `${string}{${infer Var}}${infer Rest}`
    ? Var | ExtractVariables<Rest>
    : never;

// Type-safe prompt template — compile-time error if variable is missing
class PromptTemplate<T extends string> {
  constructor(private template: T) {}

  format(vars: Record<ExtractVariables<T>, string>): string {
    let result = this.template as string;
    for (const [key, value] of Object.entries(vars)) {
      result = result.replace(new RegExp(`\\{${key}\\}`, "g"), value as string);
    }
    return result;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. TYPED EVENT EMITTER
// ─────────────────────────────────────────────────────────────────────────────

type AIEventMap = {
  "llm:start": { modelId: ModelId; prompt: string };
  "llm:chunk": { chunk: TextChunk };
  "llm:complete": { response: CompletionResponse };
  "llm:error": { error: Error };
  "tool:call": { toolName: string; args: unknown };
  "tool:result": { toolName: string; result: unknown };
};

type AIEventName = keyof AIEventMap;

class TypedEventEmitter {
  private listeners = new Map<string, Array<(data: unknown) => void>>();

  on<K extends AIEventName>(event: K, listener: (data: AIEventMap[K]) => void): this {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(listener as (data: unknown) => void);
    return this;
  }

  emit<K extends AIEventName>(event: K, data: AIEventMap[K]): void {
    this.listeners.get(event)?.forEach((listener) => listener(data));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. MAPPED TYPES + satisfies
// ─────────────────────────────────────────────────────────────────────────────

interface ProviderConfig {
  endpoint: string;
  maxTokens: number;
  supportsStreaming: boolean;
  supportsTools: boolean;
}

// Deep type utilities for config management
type DeepReadonly<T> = { readonly [K in keyof T]: T[K] extends object ? DeepReadonly<T[K]> : T[K] };
type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

type SupportedProvider = "openai" | "anthropic" | "gemini" | "mistral";

// satisfies ensures values match ProviderConfig while keeping literal types
const PROVIDER_CONFIGS = {
  openai:    { endpoint: "https://api.openai.com/v1",        maxTokens: 128_000, supportsStreaming: true,  supportsTools: true  },
  anthropic: { endpoint: "https://api.anthropic.com/v1",     maxTokens: 200_000, supportsStreaming: true,  supportsTools: true  },
  gemini:    { endpoint: "https://generativelanguage.googleapis.com/v1", maxTokens: 1_000_000, supportsStreaming: true, supportsTools: true },
  mistral:   { endpoint: "https://api.mistral.ai/v1",        maxTokens: 32_000,  supportsStreaming: true,  supportsTools: false },
} satisfies Record<SupportedProvider, ProviderConfig>;

// ─────────────────────────────────────────────────────────────────────────────
// 6. DISCRIMINATED UNIONS — AI PIPELINE STATE MACHINE
// ─────────────────────────────────────────────────────────────────────────────

type PipelineState =
  | { status: "idle" }
  | { status: "loading"; startedAt: Date }
  | { status: "processing"; progress: number; stage: string }
  | { status: "streaming"; chunks: TextChunk[]; tokensReceived: number }
  | { status: "complete"; result: CompletionResponse; duration: number }
  | { status: "error"; error: Error; retryCount: number; canRetry: boolean };

class AIStateMachine {
  private state: PipelineState = { status: "idle" };

  transition<T extends PipelineState>(newState: T): void {
    const validTransitions: Record<string, string[]> = {
      idle: ["loading"],
      loading: ["processing", "error"],
      processing: ["streaming", "complete", "error"],
      streaming: ["complete", "error"],
      complete: ["idle"],
      error: ["idle", "loading"],
    };

    const allowed = validTransitions[this.state.status] ?? [];
    if (!allowed.includes(newState.status)) {
      throw new Error(`Invalid transition: ${this.state.status} -> ${newState.status}`);
    }
    this.state = newState;
  }

  getState(): Readonly<PipelineState> {
    return this.state;
  }

  // Type narrowing in switch
  render(): string {
    const state = this.state;
    switch (state.status) {
      case "idle":
        return "Ready";
      case "loading":
        return `Loading... (${Date.now() - state.startedAt.getTime()}ms)`;
      case "processing":
        return `Processing: ${state.stage} (${state.progress}%)`;
      case "streaming":
        return `Streaming... ${state.tokensReceived} tokens`;
      case "complete":
        return `Done in ${state.duration}ms`;
      case "error":
        return `Error: ${state.error.message} ${state.canRetry ? "(retry available)" : ""}`;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. FUNCTION OVERLOADS & PIPE
// ─────────────────────────────────────────────────────────────────────────────

// Type-safe pipeline builder
function pipe<A>(value: A): A;
function pipe<A, B>(value: A, fn1: (a: A) => B): B;
function pipe<A, B, C>(value: A, fn1: (a: A) => B, fn2: (b: B) => C): C;
function pipe<A, B, C, D>(value: A, fn1: (a: A) => B, fn2: (b: B) => C, fn3: (c: C) => D): D;
function pipe(value: unknown, ...fns: Array<(arg: unknown) => unknown>): unknown {
  return fns.reduce((acc, fn) => fn(acc), value);
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. TYPE-SAFE LLM CLIENT SKELETON
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

  // ── Branded types demo ──
  const uid   = userId("usr_abc123");
  const model = modelId("gpt-4o");
  const vec   = embeddingVector([0.1, 0.2, 0.3]);
  console.log("Branded UserId:", uid);
  console.log("Branded ModelId:", model);
  console.log("Embedding vector length:", vec.length);

  // Branded IDs: ConversationId and MessageId
  const convId = conversationId("conv_001");
  const msgId  = messageId("msg_001");
  console.log("ConversationId:", convId, "MessageId:", msgId);

  // ── Cosine similarity demo ──
  const vecA = embeddingVector([1, 0, 0]);
  const vecB = embeddingVector([1, 0, 0]);
  const vecC = embeddingVector([0, 1, 0]);
  console.log("\n[Cosine Similarity]");
  console.log(`  identical vectors: ${cosineSimilarity(vecA, vecB).toFixed(4)}`);
  console.log(`  orthogonal vectors: ${cosineSimilarity(vecA, vecC).toFixed(4)}`);

  // ── Template Literal Types & Prompt Template demo ──
  console.log("\n[Prompt Template]");
  const template = new PromptTemplate("Translate '{text}' from {source} to {target}");
  const prompt = template.format({
    text: "Hello World",
    source: "English",
    target: "Vietnamese",
  });
  console.log(`  ${prompt}`);

  // ── Typed Event Emitter demo ──
  console.log("\n[Typed Event Emitter]");
  const emitter = new TypedEventEmitter();
  emitter.on("llm:start", ({ modelId: mid, prompt: p }) => {
    console.log(`  llm:start → model=${mid}, prompt="${p}"`);
  });
  emitter.on("llm:chunk", ({ chunk }) => {
    console.log(`  llm:chunk → delta="${chunk.delta}"`);
  });
  emitter.on("llm:complete", ({ response }) => {
    console.log(`  llm:complete → content="${response.content}"`);
  });
  emitter.emit("llm:start", { modelId: model, prompt: "Hello" });
  emitter.emit("llm:chunk", { chunk: { id: "c1", delta: "Hi", finishReason: null } });
  emitter.emit("llm:complete", {
    response: {
      id: "r1",
      content: "Hi there!",
      usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
      finishReason: "stop",
    },
  });

  // ── Pipe demo ──
  console.log("\n[Pipe]");
  const processedPrompt = pipe(
    "  translate this text  ",
    (text: string) => text.trim(),
    (text: string) => `You are a translator. ${text}`,
    (text: string) => ({ role: "user" as const, content: text }),
  );
  console.log(`  ${JSON.stringify(processedPrompt)}`);

  // ── Discriminated Unions / State Machine demo ──
  console.log("\n[AI State Machine]");
  const machine = new AIStateMachine();
  console.log(`  ${machine.render()}`);

  machine.transition({ status: "loading", startedAt: new Date() });
  console.log(`  ${machine.render()}`);

  machine.transition({ status: "processing", progress: 50, stage: "tokenizing" });
  console.log(`  ${machine.render()}`);

  machine.transition({ status: "streaming", chunks: [], tokensReceived: 42 });
  console.log(`  ${machine.render()}`);

  machine.transition({
    status: "complete",
    result: {
      id: "resp_1",
      content: "Done!",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      finishReason: "stop",
    },
    duration: 1200,
  });
  console.log(`  ${machine.render()}`);

  // ── LLM client demo (non-streaming) ──
  const client = new MockLLMClient("openai");

  const response = await client.complete({
    model,
    messages: [{ role: "user", content: "Hello, TypeScript AI!" }],
    stream: false,
  });
  console.log("\n[Non-streaming response]:", response);

  // ── LLM client demo (streaming) ──
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

  // ── Provider configs ──
  console.log("\n\n[Provider configs]:");
  (Object.keys(PROVIDER_CONFIGS) as SupportedProvider[]).forEach(p => {
    const cfg = PROVIDER_CONFIGS[p];
    console.log(`  ${p.padEnd(10)} maxTokens=${cfg.maxTokens.toLocaleString()} streaming=${cfg.supportsStreaming} tools=${cfg.supportsTools}`);
  });

  console.log("\n✅ Bài 1 hoàn thành!\n");
}

main().catch(console.error);

export {};

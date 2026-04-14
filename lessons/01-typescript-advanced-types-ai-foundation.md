# Bài 1: TypeScript Advanced Types & AI Foundation

## Mục tiêu bài học

- Nắm vững Conditional Types, Template Literal Types, Infer, Mapped Types
- Sử dụng Branded Types để tăng type safety cho AI systems
- Xây dựng type-safe API client cho LLM providers
- Hiểu cách TypeScript type system giúp model AI pipelines

---

## 1.1 Conditional Types & Infer — Nền tảng cho AI Pipeline Typing

```typescript
// Conditional types giúp ta tạo type transformations phức tạp
type IsPromise<T> = T extends Promise<infer U> ? U : never;

// Áp dụng cho AI response types
type UnwrapAIResponse<T> = T extends AsyncIterable<infer Chunk>
  ? Chunk
  : T extends Promise<infer Value>
  ? Value
  : T;

// Ví dụ thực tế: typing streaming vs non-streaming LLM response
type LLMMode = "stream" | "complete";

type LLMResponse<M extends LLMMode> = M extends "stream"
  ? AsyncIterable<TextChunk>
  : CompletionResponse;

interface TextChunk {
  id: string;
  delta: string;
  finishReason: "stop" | "length" | "tool_call" | null;
}

interface CompletionResponse {
  id: string;
  content: string;
  usage: TokenUsage;
  finishReason: "stop" | "length" | "tool_call";
}

interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

// Generic LLM caller với conditional return type
async function callLLM<M extends LLMMode>(
  prompt: string,
  mode: M,
  options?: LLMOptions
): Promise<LLMResponse<M>> {
  if (mode === "stream") {
    return streamLLM(prompt, options) as Promise<LLMResponse<M>>;
  }
  return completeLLM(prompt, options) as Promise<LLMResponse<M>>;
}

interface LLMOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

async function* streamLLM(
  prompt: string,
  options?: LLMOptions
): AsyncIterable<TextChunk> {
  // Implementation với streaming
  yield { id: "1", delta: "Hello", finishReason: null };
  yield { id: "2", delta: " World", finishReason: "stop" };
}

async function completeLLM(
  prompt: string,
  options?: LLMOptions
): Promise<CompletionResponse> {
  return {
    id: crypto.randomUUID(),
    content: "Hello World",
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    finishReason: "stop",
  };
}
```

---

## 1.2 Branded Types — Type Safety cho AI Identifiers

Branded types ngăn chặn việc nhầm lẫn giữa các string/number có ý nghĩa khác nhau.

```typescript
// Branded type utility
declare const __brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [__brand]: B };

// AI-specific branded types
type ModelId = Brand<string, "ModelId">;
type ConversationId = Brand<string, "ConversationId">;
type MessageId = Brand<string, "MessageId">;
type EmbeddingId = Brand<string, "EmbeddingId">;
type DocumentId = Brand<string, "DocumentId">;
type UserId = Brand<string, "UserId">;

// Constructor functions
const ModelId = (id: string): ModelId => id as ModelId;
const ConversationId = (id: string): ConversationId => id as ConversationId;
const MessageId = (id: string): MessageId => id as MessageId;
const EmbeddingId = (id: string): EmbeddingId => id as EmbeddingId;

// Type-safe message structure
interface Message {
  id: MessageId;
  conversationId: ConversationId;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  createdAt: Date;
}

interface Conversation {
  id: ConversationId;
  userId: UserId;
  modelId: ModelId;
  messages: Message[];
  metadata: Record<string, unknown>;
}

// Lỗi compile-time: không thể nhầm ConversationId với MessageId
function getMessage(
  conversationId: ConversationId,
  messageId: MessageId
): Message | undefined {
  // TypeScript sẽ báo lỗi nếu bạn truyền sai order
  return undefined;
}

// Branded numeric types cho embeddings
type EmbeddingDimension = Brand<number, "EmbeddingDimension">;
type CosineSimilarity = Brand<number, "CosineSimilarity">;

type EmbeddingVector = Float32Array & { readonly dimension: EmbeddingDimension };

function cosineSimilarity(a: EmbeddingVector, b: EmbeddingVector): CosineSimilarity {
  if (a.dimension !== b.dimension) {
    throw new Error(`Dimension mismatch: ${a.dimension} vs ${b.dimension}`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return (dot / (Math.sqrt(normA) * Math.sqrt(normB))) as CosineSimilarity;
}
```

---

## 1.3 Template Literal Types — Typed Prompt Engineering

```typescript
// Template literal types cho prompt templates
type PromptVariable = `{${string}}`;

type ExtractVariables<T extends string> =
  T extends `${string}{${infer Var}}${infer Rest}`
    ? Var | ExtractVariables<Rest>
    : never;

// Magic: TypeScript tự động extract variables từ prompt string
type UserPromptVars = ExtractVariables<"Hello {name}, your score is {score}">;
// => "name" | "score"

// Type-safe prompt template
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

// Compile-time error nếu thiếu variable
const template = new PromptTemplate(
  "Translate '{text}' from {source} to {target}"
);

const prompt = template.format({
  text: "Hello World",
  source: "English",
  target: "Vietnamese",
  // Nếu thêm key không tồn tại -> lỗi TypeScript!
});

// Typed event system cho AI pipeline
type AIEventMap = {
  "llm:start": { modelId: ModelId; prompt: string };
  "llm:chunk": { chunk: TextChunk };
  "llm:complete": { response: CompletionResponse };
  "llm:error": { error: Error };
  "tool:call": { toolName: string; args: unknown };
  "tool:result": { toolName: string; result: unknown };
  "memory:store": { key: string; value: unknown };
  "memory:retrieve": { key: string; value: unknown };
};

type AIEventName = keyof AIEventMap;

class TypedEventEmitter {
  private listeners = new Map<string, Array<(data: unknown) => void>>();

  on<K extends AIEventName>(
    event: K,
    listener: (data: AIEventMap[K]) => void
  ): this {
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

// Usage: fully type-safe event system
const emitter = new TypedEventEmitter();
emitter.on("llm:chunk", ({ chunk }) => {
  console.log(chunk.delta); // TypeScript knows this is TextChunk
});
```

---

## 1.4 Mapped Types & Utility Types — AI Config Management

```typescript
// Deep Readonly cho immutable AI configs
type DeepReadonly<T> = {
  readonly [K in keyof T]: T[K] extends object ? DeepReadonly<T[K]> : T[K];
};

// Deep Partial cho optional overrides
type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

// Merge types cho config inheritance
type Merge<Base, Override> = Omit<Base, keyof Override> & Override;

// AI Provider configuration
interface BaseProviderConfig {
  apiKey: string;
  baseUrl: string;
  timeout: number;
  retryAttempts: number;
  retryDelay: number;
}

interface OpenAIConfig extends BaseProviderConfig {
  organization?: string;
  defaultModel: ModelId;
  embeddingModel: ModelId;
}

interface AnthropicConfig extends BaseProviderConfig {
  defaultModel: ModelId;
  maxTokensToSample: number;
}

// Type-safe config with defaults
type ConfigWithDefaults<T extends BaseProviderConfig> = Merge<
  Required<BaseProviderConfig>,
  T
>;

// Mapped type để tạo validation schema từ config type
type ValidationSchema<T> = {
  [K in keyof T]-?: {
    required: undefined extends T[K] ? false : true;
    type: T[K] extends string
      ? "string"
      : T[K] extends number
      ? "number"
      : T[K] extends boolean
      ? "boolean"
      : "object";
    validate?: (value: T[K]) => boolean;
  };
};

// Auto-generated validation từ config type
function createValidator<T extends Record<string, unknown>>(
  schema: ValidationSchema<T>
) {
  return function validate(config: Partial<T>): config is T {
    for (const [key, rules] of Object.entries(schema) as Array<
      [string, ValidationSchema<T>[keyof T]]
    >) {
      const value = config[key as keyof T];
      if (rules.required && value === undefined) {
        throw new Error(`Missing required config: ${key}`);
      }
      if (value !== undefined && rules.validate && !rules.validate(value as T[keyof T])) {
        throw new Error(`Invalid config value for: ${key}`);
      }
    }
    return true;
  };
}
```

---

## 1.5 Discriminated Unions — AI State Machine

```typescript
// AI pipeline states as discriminated union
type PipelineState =
  | { status: "idle" }
  | { status: "loading"; startedAt: Date }
  | { status: "processing"; progress: number; stage: string }
  | { status: "streaming"; chunks: TextChunk[]; tokensReceived: number }
  | { status: "complete"; result: CompletionResponse; duration: number }
  | { status: "error"; error: Error; retryCount: number; canRetry: boolean };

// Type-safe state transitions
type StateTransition<From extends PipelineState["status"], To extends PipelineState["status"]> = {
  from: From;
  to: To;
  guard?: (state: Extract<PipelineState, { status: From }>) => boolean;
  action: (state: Extract<PipelineState, { status: From }>) => Extract<PipelineState, { status: To }>;
};

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
      throw new Error(
        `Invalid transition: ${this.state.status} -> ${newState.status}`
      );
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

// Demo
const machine = new AIStateMachine();
machine.transition({ status: "loading", startedAt: new Date() });
machine.transition({ status: "processing", progress: 25, stage: "tokenizing" });
machine.transition({
  status: "streaming",
  chunks: [],
  tokensReceived: 0,
});
machine.transition({
  status: "complete",
  result: {
    id: "resp_1",
    content: "Hello!",
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    finishReason: "stop",
  },
  duration: 1200,
});
```

---

## 1.6 Function Overloads & Generics — Universal AI Client

```typescript
// Universal AI client với full type safety
interface AIClient {
  // Overloads cho streaming vs non-streaming
  complete(prompt: string, options: { stream: true } & LLMOptions): Promise<AsyncIterable<TextChunk>>;
  complete(prompt: string, options?: { stream?: false } & LLMOptions): Promise<CompletionResponse>;
  complete(prompt: string, options?: { stream?: boolean } & LLMOptions): Promise<CompletionResponse | AsyncIterable<TextChunk>>;
}

// Result type dựa trên options
type CompletionResult<O extends { stream?: boolean }> = O extends { stream: true }
  ? AsyncIterable<TextChunk>
  : CompletionResponse;

// Pipe operator cho AI pipeline
type Pipe<T, Fns extends Array<(arg: unknown) => unknown>> = Fns extends [
  (arg: T) => infer R,
  ...infer Rest
]
  ? Rest extends Array<(arg: unknown) => unknown>
    ? Pipe<R, Rest>
    : R
  : T;

// Type-safe pipeline builder
function pipe<A>(value: A): A;
function pipe<A, B>(value: A, fn1: (a: A) => B): B;
function pipe<A, B, C>(value: A, fn1: (a: A) => B, fn2: (b: B) => C): C;
function pipe<A, B, C, D>(
  value: A,
  fn1: (a: A) => B,
  fn2: (b: B) => C,
  fn3: (c: C) => D
): D;
function pipe(value: unknown, ...fns: Array<(arg: unknown) => unknown>): unknown {
  return fns.reduce((acc, fn) => fn(acc), value);
}

// Usage
const processedPrompt = pipe(
  "translate this text",
  (text) => text.trim(),
  (text) => `You are a translator. ${text}`,
  (text) => ({ role: "user" as const, content: text })
);
```

---

## Tóm tắt Bài 1

| Concept | Ứng dụng trong AI |
|---------|-------------------|
| Conditional Types | Typing streaming vs non-streaming responses |
| Branded Types | Type-safe IDs cho messages, conversations, models |
| Template Literal Types | Type-safe prompt templates với variable extraction |
| Mapped Types | Auto-generate validation schemas từ config types |
| Discriminated Unions | AI pipeline state machine |
| Function Overloads | Universal AI client với type-safe overloads |

## Bài tập thực hành

1. Tạo một `PromptBuilder` class sử dụng Template Literal Types để đảm bảo tất cả variables được điền đầy đủ trước khi gửi lên LLM.
2. Implement một `RetryableAIClient` sử dụng Discriminated Unions để track retry state và exponential backoff.
3. Viết `ValidatedConfig` utility type tự động validate required fields từ bất kỳ config interface nào.

---

*Tiếp theo: [Bài 2 — Offline-First Architecture Core Concepts](02-offline-first-architecture.md)*

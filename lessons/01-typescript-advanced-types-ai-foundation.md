# Bài 1: TypeScript Advanced Types & AI Foundation

## Mục tiêu bài học

- Nắm vững Conditional Types, Template Literal Types, Infer, Mapped Types
- Sử dụng Branded Types để tăng type safety cho AI systems
- Xây dựng type-safe API client cho LLM providers
- Hiểu cách TypeScript type system giúp model AI pipelines

---

## 1.1 Conditional Types & Infer — Nền tảng cho AI Pipeline Typing

Conditional types giúp ta tạo type transformations phức tạp, đặc biệt hữu ích khi typing streaming vs non-streaming LLM responses.

```typescript
type LLMMode = "stream" | "complete";

type LLMResponse<M extends LLMMode> = M extends "stream"
  ? AsyncIterable<TextChunk>
  : CompletionResponse;

// Utility: unwrap element type từ AsyncIterable
type AsyncIterableItem<T> = T extends AsyncIterable<infer Item> ? Item : never;
```

Generic LLM caller sử dụng conditional return type để TypeScript tự chọn kiểu trả về đúng:

```typescript
async function callLLM<M extends LLMMode>(
  prompt: string,
  mode: M
): Promise<LLMResponse<M>> {
  // mode === "stream" → trả về AsyncIterable<TextChunk>
  // mode === "complete" → trả về CompletionResponse
}
```

---

## 1.2 Branded Types — Type Safety cho AI Identifiers

Branded types ngăn chặn việc nhầm lẫn giữa các string/number có ý nghĩa khác nhau.

```typescript
declare const __brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [__brand]: B };

type ModelId = Brand<string, "ModelId">;
type UserId = Brand<string, "UserId">;
type ConversationId = Brand<string, "ConversationId">;

// Constructor function enforce tại boundary
function userId(raw: string): UserId {
  if (!raw.startsWith("usr_")) throw new Error(`Invalid UserId`);
  return raw as UserId;
}
```

Nhờ branded types, TypeScript sẽ báo lỗi compile-time nếu bạn truyền nhầm `ConversationId` vào chỗ cần `MessageId`.

---

## 1.3 Template Literal Types — Typed Prompt Engineering

TypeScript có thể tự động extract variables từ prompt string tại compile-time:

```typescript
type ExtractVariables<T extends string> =
  T extends `${string}{${infer Var}}${infer Rest}`
    ? Var | ExtractVariables<Rest>
    : never;

// "name" | "score"
type Vars = ExtractVariables<"Hello {name}, your score is {score}">;
```

Áp dụng để xây dựng type-safe prompt template — compile-time error nếu thiếu variable:

```typescript
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
```

Typed event system cho AI pipeline sử dụng template literal types:

```typescript
type AIEvent =
  | `llm:${"start" | "token" | "end" | "error"}`
  | `agent:${"think" | "act" | "observe" | "done"}`
  | `rag:${"retrieve" | "rank" | "generate"}`;
```

---

## 1.4 Mapped Types & Utility Types — AI Config Management

Mapped types tạo type transformations trên toàn bộ object:

```typescript
type DeepReadonly<T> = {
  readonly [K in keyof T]: T[K] extends object ? DeepReadonly<T[K]> : T[K];
};

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};
```

Kết hợp `satisfies` để giữ literal types trong khi enforce shape:

```typescript
const PROVIDER_CONFIGS = {
  openai:    { endpoint: "https://api.openai.com/v1", maxTokens: 128_000 },
  anthropic: { endpoint: "https://api.anthropic.com/v1", maxTokens: 200_000 },
} satisfies Record<string, ProviderConfig>;
```

---

## 1.5 Discriminated Unions — AI State Machine

Discriminated unions cho phép type narrowing tự động trong switch/if:

```typescript
type PipelineState =
  | { status: "idle" }
  | { status: "loading"; startedAt: Date }
  | { status: "streaming"; tokensReceived: number }
  | { status: "complete"; result: CompletionResponse; duration: number }
  | { status: "error"; error: Error; canRetry: boolean };
```

State machine validate transitions tại runtime, TypeScript narrow types trong switch:

```typescript
switch (state.status) {
  case "streaming":
    console.log(state.tokensReceived); // TS knows this exists
  case "error":
    console.log(state.error.message);  // TS knows this exists
}
```

---

## 1.6 Function Overloads & Generics — Universal AI Client

Function overloads cho phép return type thay đổi theo input:

```typescript
interface LLMClient {
  complete(opts: RequestOptions & { stream: false }): Promise<CompletionResponse>;
  complete(opts: RequestOptions & { stream: true }): Promise<AsyncIterable<TextChunk>>;
}
```

Type-safe pipe function cho AI pipeline:

```typescript
function pipe<A, B, C>(value: A, fn1: (a: A) => B, fn2: (b: B) => C): C;

const result = pipe(
  "translate this",
  (text) => text.trim(),
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

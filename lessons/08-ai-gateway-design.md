# Bài 8: AI Gateway Design với TypeScript

## Mục tiêu bài học

- Thiết kế AI Gateway với multi-provider abstraction
- Implement Rate Limiting, Quota Management, Auth middleware
- Xây dựng Semantic Caching cho LLM responses
- Model Routing: intelligent routing giữa GPT-4, Claude, Gemini

---

## 8.1 AI Gateway Architecture

```typescript
// Core gateway types
import { IncomingMessage, ServerResponse } from "http";

type HTTPMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

interface GatewayRequest {
  id: string;                  // Request ID for tracing
  method: HTTPMethod;
  path: string;
  headers: Record<string, string>;
  body: unknown;
  userId: string;
  organizationId: string;
  timestamp: Date;
  clientIp: string;
}

interface GatewayResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  requestId: string;
  latencyMs: number;
  model?: string;
  tokensUsed?: { prompt: number; completion: number };
  cached?: boolean;
}

// Middleware pattern (Koa/Express-style)
type NextFunction = () => Promise<void>;
type Middleware = (
  req: GatewayRequest,
  res: Partial<GatewayResponse>,
  next: NextFunction
) => Promise<void>;

class GatewayPipeline {
  private middlewares: Middleware[] = [];

  use(middleware: Middleware): this {
    this.middlewares.push(middleware);
    return this;
  }

  async execute(req: GatewayRequest): Promise<GatewayResponse> {
    const res: Partial<GatewayResponse> = {
      requestId: req.id,
      headers: {},
    };

    let index = 0;

    const next: NextFunction = async () => {
      if (index < this.middlewares.length) {
        const middleware = this.middlewares[index++];
        await middleware(req, res, next);
      }
    };

    const start = Date.now();
    await next();

    return {
      status: 200,
      headers: {},
      body: null,
      requestId: req.id,
      latencyMs: Date.now() - start,
      ...res,
    };
  }
}
```

---

## 8.2 Rate Limiting Middleware

```typescript
// Token Bucket Rate Limiter (production-grade)
interface TokenBucket {
  tokens: number;
  lastRefill: number;
  capacity: number;
  refillRate: number; // tokens per second
}

class RateLimiter {
  private buckets = new Map<string, TokenBucket>();

  constructor(
    private config: {
      requestsPerMinute: number;
      tokensPerMinute: number;
      burstCapacity: number;
    }
  ) {}

  checkRequest(key: string, requestedTokens: number = 1): {
    allowed: boolean;
    remaining: number;
    resetAt: Date;
    retryAfter?: number;
  } {
    const bucket = this.getOrCreateBucket(key);
    this.refillBucket(bucket);

    if (bucket.tokens < requestedTokens) {
      const retryAfter = Math.ceil(
        (requestedTokens - bucket.tokens) / bucket.refillRate
      );
      return {
        allowed: false,
        remaining: Math.floor(bucket.tokens),
        resetAt: new Date(Date.now() + retryAfter * 1000),
        retryAfter,
      };
    }

    bucket.tokens -= requestedTokens;
    return {
      allowed: true,
      remaining: Math.floor(bucket.tokens),
      resetAt: new Date(Date.now() + (bucket.capacity - bucket.tokens) / bucket.refillRate * 1000),
    };
  }

  private getOrCreateBucket(key: string): TokenBucket {
    if (!this.buckets.has(key)) {
      this.buckets.set(key, {
        tokens: this.config.burstCapacity,
        lastRefill: Date.now(),
        capacity: this.config.burstCapacity,
        refillRate: this.config.requestsPerMinute / 60,
      });
    }
    return this.buckets.get(key)!;
  }

  private refillBucket(bucket: TokenBucket): void {
    const now = Date.now();
    const elapsed = (now - bucket.lastRefill) / 1000;
    const tokensToAdd = elapsed * bucket.refillRate;
    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + tokensToAdd);
    bucket.lastRefill = now;
  }
}

// Rate limiting middleware factory
function createRateLimitMiddleware(
  limiter: RateLimiter,
  keyExtractor: (req: GatewayRequest) => string = (req) => req.userId
): Middleware {
  return async (req, res, next) => {
    const key = keyExtractor(req);
    const result = limiter.checkRequest(key);

    res.headers = {
      ...res.headers,
      "X-RateLimit-Remaining": result.remaining.toString(),
      "X-RateLimit-Reset": result.resetAt.toISOString(),
    };

    if (!result.allowed) {
      res.status = 429;
      res.body = {
        error: "rate_limit_exceeded",
        message: "Too many requests",
        retryAfter: result.retryAfter,
      };
      if (result.retryAfter) {
        res.headers["Retry-After"] = result.retryAfter.toString();
      }
      return; // Don't call next
    }

    await next();
  };
}
```

---

## 8.3 Multi-Provider AI Abstraction

```typescript
// Provider-agnostic AI interface
interface LLMProvider {
  id: string;
  name: string;
  models: string[];
  complete(request: LLMRequest): Promise<LLMResponse>;
  stream(request: LLMRequest): AsyncIterable<LLMStreamChunk>;
  countTokens(text: string, model: string): Promise<number>;
  getCapabilities(): ProviderCapabilities;
}

interface LLMRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  temperature?: number;
  maxTokens?: number;
  tools?: ToolDefinition[];
  toolChoice?: "auto" | "none" | "required";
  responseFormat?: { type: "json_object" | "text" };
  stop?: string[];
  stream?: boolean;
}

interface LLMResponse {
  id: string;
  model: string;
  content: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  finishReason: string;
  latencyMs: number;
}

interface LLMStreamChunk {
  id: string;
  delta: string;
  toolCallDelta?: { id?: string; name?: string; arguments?: string };
  finishReason: string | null;
}

interface ProviderCapabilities {
  maxContextTokens: number;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsStreaming: boolean;
  supportsJsonMode: boolean;
  costPer1kInputTokens: number;   // USD
  costPer1kOutputTokens: number;  // USD
}

interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

// OpenAI Provider implementation
class OpenAIProvider implements LLMProvider {
  id = "openai";
  name = "OpenAI";
  models = ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-3.5-turbo"];

  constructor(
    private apiKey: string,
    private baseUrl: string = "https://api.openai.com/v1"
  ) {}

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const start = Date.now();
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        temperature: request.temperature,
        max_tokens: request.maxTokens,
        tools: request.tools?.map((t) => ({
          type: "function",
          function: t,
        })),
        tool_choice: request.toolChoice,
        response_format: request.responseFormat,
        stop: request.stop,
      }),
    });

    if (!response.ok) {
      const error = await response.json() as { error: { message: string } };
      throw new ProviderError("openai", response.status, error.error.message);
    }

    const data = await response.json() as OpenAICompletionResponse;
    const choice = data.choices[0];

    return {
      id: data.id,
      model: data.model,
      content: choice.message.content ?? "",
      toolCalls: choice.message.tool_calls?.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      })),
      usage: {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens,
      },
      finishReason: choice.finish_reason,
      latencyMs: Date.now() - start,
    };
  }

  async *stream(request: LLMRequest): AsyncIterable<LLMStreamChunk> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ ...request, stream: true }),
    });

    if (!response.ok || !response.body) {
      throw new ProviderError("openai", response.status, "Stream failed");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6);
        if (data === "[DONE]") return;

        try {
          const chunk = JSON.parse(data) as OpenAIStreamChunk;
          const delta = chunk.choices[0]?.delta;
          if (!delta) continue;

          yield {
            id: chunk.id,
            delta: delta.content ?? "",
            finishReason: chunk.choices[0]?.finish_reason ?? null,
          };
        } catch {
          // Skip malformed chunks
        }
      }
    }
  }

  async countTokens(text: string, model: string): Promise<number> {
    // Approximate: 1 token ≈ 4 characters
    return Math.ceil(text.length / 4);
  }

  getCapabilities(): ProviderCapabilities {
    return {
      maxContextTokens: 128000,
      supportsTools: true,
      supportsVision: true,
      supportsStreaming: true,
      supportsJsonMode: true,
      costPer1kInputTokens: 0.005,
      costPer1kOutputTokens: 0.015,
    };
  }
}

// OpenAI API response types
interface OpenAICompletionResponse {
  id: string;
  model: string;
  choices: Array<{
    message: {
      content: string | null;
      tool_calls?: Array<{
        id: string;
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string;
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

interface OpenAIStreamChunk {
  id: string;
  choices: Array<{
    delta: { content?: string; tool_calls?: unknown[] };
    finish_reason: string | null;
  }>;
}

class ProviderError extends Error {
  constructor(
    public provider: string,
    public statusCode: number,
    message: string
  ) {
    super(`[${provider}] ${message} (${statusCode})`);
    this.name = "ProviderError";
  }
}
```

---

## 8.4 Intelligent Model Router

```typescript
// Route requests to optimal model based on requirements
interface RoutingConfig {
  rules: RoutingRule[];
  fallback: string; // model id
}

interface RoutingRule {
  condition: (req: LLMRequest, context: RoutingContext) => boolean;
  targetModel: string;
  reason: string;
}

interface RoutingContext {
  estimatedTokens: number;
  hasImages: boolean;
  requiresTools: boolean;
  requiresJsonMode: boolean;
  budget?: number; // Max cost in USD
  latencyTarget?: number; // Max latency in ms
}

class ModelRouter {
  private providers = new Map<string, LLMProvider>();

  constructor(private config: RoutingConfig) {}

  registerProvider(provider: LLMProvider): void {
    for (const model of provider.models) {
      this.providers.set(model, provider);
    }
  }

  async route(
    request: LLMRequest,
    context: RoutingContext
  ): Promise<{ model: string; provider: LLMProvider; reason: string }> {
    for (const rule of this.config.rules) {
      if (rule.condition(request, context)) {
        const provider = this.providers.get(rule.targetModel);
        if (provider) {
          return { model: rule.targetModel, provider, reason: rule.reason };
        }
      }
    }

    const fallbackProvider = this.providers.get(this.config.fallback);
    if (!fallbackProvider) {
      throw new Error(`No provider for fallback model: ${this.config.fallback}`);
    }
    return {
      model: this.config.fallback,
      provider: fallbackProvider,
      reason: "Default fallback",
    };
  }
}

// Example routing configuration
const routingConfig: RoutingConfig = {
  fallback: "gpt-4o-mini",
  rules: [
    // Route vision requests to capable models
    {
      condition: (_, ctx) => ctx.hasImages,
      targetModel: "gpt-4o",
      reason: "Vision capability required",
    },
    // Route tool-heavy requests to best model
    {
      condition: (req, ctx) => ctx.requiresTools && req.tools && req.tools.length > 3,
      targetModel: "gpt-4o",
      reason: "Complex tool use",
    },
    // Route large context to appropriate model
    {
      condition: (_, ctx) => ctx.estimatedTokens > 50000,
      targetModel: "gpt-4o",
      reason: "Large context window needed",
    },
    // Route budget-conscious to cheaper model
    {
      condition: (_, ctx) => ctx.budget !== undefined && ctx.budget < 0.01,
      targetModel: "gpt-4o-mini",
      reason: "Budget constraint",
    },
    // Route latency-sensitive to faster model
    {
      condition: (_, ctx) => ctx.latencyTarget !== undefined && ctx.latencyTarget < 1000,
      targetModel: "gpt-4o-mini",
      reason: "Low latency requirement",
    },
  ],
};
```

---

## 8.5 Semantic Cache Middleware

```typescript
// Semantic caching: cache by embedding similarity, not exact match
class SemanticCache {
  private entries: Array<{
    key: string;
    embedding: number[];
    response: LLMResponse;
    model: string;
    createdAt: Date;
    ttl: number;
    hitCount: number;
  }> = [];

  constructor(
    private embedder: { embed(text: string): Promise<number[]> },
    private options: {
      similarityThreshold: number; // 0.95 = very similar
      maxEntries: number;
      defaultTtlMs: number;
    }
  ) {}

  async get(
    request: LLMRequest
  ): Promise<{ response: LLMResponse; similarity: number } | null> {
    const queryText = this.requestToText(request);
    const queryEmbedding = await this.embedder.embed(queryText);

    const now = Date.now();
    let best: { entry: typeof this.entries[0]; similarity: number } | null = null;

    for (const entry of this.entries) {
      if (entry.model !== request.model) continue;
      if (now > entry.createdAt.getTime() + entry.ttl) continue;

      const similarity = this.cosineSimilarity(queryEmbedding, entry.embedding);
      if (
        similarity >= this.options.similarityThreshold &&
        (!best || similarity > best.similarity)
      ) {
        best = { entry, similarity };
      }
    }

    if (best) {
      best.entry.hitCount++;
      return { response: best.entry.response, similarity: best.similarity };
    }

    return null;
  }

  async set(request: LLMRequest, response: LLMResponse): Promise<void> {
    const queryText = this.requestToText(request);
    const embedding = await this.embedder.embed(queryText);

    // Evict oldest if at capacity
    if (this.entries.length >= this.options.maxEntries) {
      this.entries.sort((a, b) => a.hitCount - b.hitCount);
      this.entries.shift();
    }

    this.entries.push({
      key: crypto.randomUUID(),
      embedding,
      response,
      model: request.model,
      createdAt: new Date(),
      ttl: this.options.defaultTtlMs,
      hitCount: 0,
    });
  }

  private requestToText(request: LLMRequest): string {
    return request.messages
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .join("\n");
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  getStats() {
    const total = this.entries.reduce((s, e) => s + e.hitCount, 0);
    return {
      entries: this.entries.length,
      totalHits: total,
      hitRate: total / (total + this.entries.length),
    };
  }
}

// Complete AI Gateway
class AIGateway {
  private pipeline: GatewayPipeline;

  constructor(
    private router: ModelRouter,
    private rateLimiter: RateLimiter,
    private semanticCache: SemanticCache
  ) {
    this.pipeline = new GatewayPipeline();
    this.setupMiddlewares();
  }

  private setupMiddlewares(): void {
    // 1. Request ID
    this.pipeline.use(async (req, res, next) => {
      res.headers = { ...res.headers, "X-Request-ID": req.id };
      await next();
    });

    // 2. Auth (simplified)
    this.pipeline.use(async (req, res, next) => {
      if (!req.userId) {
        res.status = 401;
        res.body = { error: "unauthorized" };
        return;
      }
      await next();
    });

    // 3. Rate limit
    this.pipeline.use(
      createRateLimitMiddleware(this.rateLimiter, (req) => req.userId)
    );

    // 4. Semantic cache check
    this.pipeline.use(async (req, res, next) => {
      const llmRequest = req.body as LLMRequest;
      const cached = await this.semanticCache.get(llmRequest);
      if (cached) {
        res.status = 200;
        res.body = cached.response;
        res.cached = true;
        res.headers = {
          ...res.headers,
          "X-Cache": "HIT",
          "X-Cache-Similarity": cached.similarity.toFixed(4),
        };
        return; // Skip next
      }
      res.headers = { ...res.headers, "X-Cache": "MISS" };
      await next();
    });

    // 5. Route & Execute
    this.pipeline.use(async (req, res, next) => {
      const llmRequest = req.body as LLMRequest;
      const context: RoutingContext = {
        estimatedTokens: 0, // Would estimate from messages
        hasImages: false,
        requiresTools: (llmRequest.tools?.length ?? 0) > 0,
        requiresJsonMode: llmRequest.responseFormat?.type === "json_object",
      };

      const { model, provider, reason } = await this.router.route(llmRequest, context);
      res.headers = {
        ...res.headers,
        "X-Model-Used": model,
        "X-Routing-Reason": reason,
      };

      const response = await provider.complete({ ...llmRequest, model });
      
      // Cache the response
      await this.semanticCache.set(llmRequest, response);

      res.status = 200;
      res.body = response;
      res.model = model;
      res.tokensUsed = {
        prompt: response.usage.promptTokens,
        completion: response.usage.completionTokens,
      };
    });
  }

  async handleRequest(req: GatewayRequest): Promise<GatewayResponse> {
    return this.pipeline.execute(req);
  }
}
```

---

## Tóm tắt Bài 8

| Component | Responsibility | TypeScript Pattern |
|-----------|---------------|-------------------|
| GatewayPipeline | Middleware chain | Strategy pattern |
| RateLimiter | Token bucket per user | Class + Map |
| LLMProvider | Provider abstraction | Interface + implementations |
| ModelRouter | Intelligent routing | Rule-based + provider registry |
| SemanticCache | Similarity-based caching | Embedding + cosine similarity |
| AIGateway | Orchestrate all components | Composition root |

## Bài tập thực hành

1. Implement **Quota Manager**: tổng token budget per user per month, với alerts khi đạt 80%.
2. Thêm **Cost Tracking middleware**: tính toán và log cost của mỗi request.
3. Implement **A/B Testing**: 10% traffic dùng model mới, 90% dùng model cũ, so sánh quality metrics.

---

*Tiếp theo: [Bài 9 — LLM Orchestration với TypeScript](09-llm-orchestration.md)*

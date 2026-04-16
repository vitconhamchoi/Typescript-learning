# Bài 8: AI Gateway Design với TypeScript

## Mục tiêu bài học

- Thiết kế AI Gateway với multi-provider abstraction
- Implement Rate Limiting, Quota Management, Auth middleware
- Xây dựng Semantic Caching cho LLM responses
- Model Routing: intelligent routing giữa GPT-4, Claude, Gemini

---

## 8.1 AI Gateway Architecture

Gateway nhận mọi request từ client, đi qua middleware pipeline (auth → rate limit → cache → routing → provider), rồi trả response. Mỗi middleware gọi `next()` để chuyển tiếp hoặc dừng pipeline sớm.

```typescript
interface GatewayRequest {
  id: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
  userId: string;
  timestamp: Date;
}

interface GatewayResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  latencyMs: number;
}

type NextFunction = () => Promise<void>;
type Middleware = (req: GatewayRequest, res: Partial<GatewayResponse>, next: NextFunction) => Promise<void>;

// Pipeline chạy middleware theo thứ tự, mỗi middleware gọi next() để tiếp tục
const pipeline = new GatewayPipeline();
pipeline.use(authMiddleware).use(rateLimitMiddleware).use(cacheMiddleware);
const response = await pipeline.execute(request);
```

---

## 8.2 Rate Limiting Middleware

Token Bucket algorithm: mỗi bucket có capacity cố định, tự refill theo thời gian. Mỗi request "consume" token — nếu hết token thì bị block. Pattern factory tạo middleware từ limiter instance.

```typescript
interface TokenBucket {
  tokens: number;
  lastRefill: number;
  capacity: number;
  refillRate: number; // tokens per second
}

// RateLimiter trả về thông tin cho response headers
type CheckResult = {
  allowed: boolean;
  remaining: number;
  retryAfter?: number;
};

// Factory pattern: tạo middleware từ limiter + key extractor
function createRateLimitMiddleware(
  limiter: RateLimiter,
  keyExtractor: (req: GatewayRequest) => string
): Middleware {
  return async (req, res, next) => {
    const result = limiter.check(keyExtractor(req));
    if (!result.allowed) { res.status = 429; return; }
    await next();
  };
}
```

---

## 8.3 Multi-Provider AI Abstraction

Abstraction layer để gateway giao tiếp với bất kỳ LLM provider nào (OpenAI, Anthropic, Gemini) qua một interface thống nhất. Mỗi provider tự khai báo capabilities để router quyết định routing.

```typescript
interface LLMProvider {
  id: string;
  name: string;
  models: string[];
  complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse>;
  countTokens(text: string): number;
  getCapabilities(): ProviderCapabilities;
}

interface LLMCompletionRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  temperature?: number;
  maxTokens?: number;
}

interface LLMCompletionResponse {
  id: string;
  model: string;
  content: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  latencyMs: number;
}

interface ProviderCapabilities {
  maxContextTokens: number;
  supportsTools: boolean;
  supportsStreaming: boolean;
  costPer1kInputTokens: number;
  costPer1kOutputTokens: number;
}
```

---

## 8.4 Intelligent Model Router

Rule-based routing: đánh giá từng rule theo thứ tự, rule đầu tiên match sẽ quyết định model. Nếu không rule nào match → dùng fallback model. Context chứa metadata (token count, budget, latency target) để rule đánh giá.

```typescript
interface RoutingRule {
  condition: (req: LLMCompletionRequest, ctx: RoutingContext) => boolean;
  targetModel: string;
  reason: string;
}

interface RoutingContext {
  estimatedTokens: number;
  requiresTools: boolean;
  budget?: number;
  latencyTarget?: number;
}

// Router đánh giá rules theo thứ tự, trả về model + reason
class ModelRouter {
  route(req: LLMCompletionRequest, ctx: RoutingContext): {
    model: string;
    reason: string;
  }; // returns first matching rule or fallback
}
```

---

## 8.5 Semantic Cache Middleware

Cache dựa trên semantic similarity thay vì exact match. Dùng cosine similarity giữa embeddings để tìm cached response tương tự. AIGateway kết hợp tất cả components (rate limiter, cache, router, providers) thành một hệ thống hoàn chỉnh.

```typescript
// Cosine similarity giữa hai vectors — core của semantic cache
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// AIGateway = composition root kết hợp mọi component
class AIGateway {
  constructor(
    private rateLimiter: RateLimiterMiddleware,
    private cache: SemanticCache,
    private router: GatewayRouter,
    private ruleRouter: RuleBasedRouter
  ) {}
  async handle(req: GatewayRequest): Promise<ProviderResponse> { /* ... */ }
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

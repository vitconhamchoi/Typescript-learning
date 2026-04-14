/**
 * Bài 8: AI Gateway Design in TypeScript
 * ========================================
 * Chạy: npm run lesson08
 *
 * Nội dung:
 *  - Token Bucket rate limiter (per-tenant)
 *  - Semantic cache (hash-based mock)
 *  - Multi-provider router with fallback chain
 *  - Request/response logging middleware
 *  - Cost tracker
 */

import { EventEmitter } from "eventemitter3";

// ─────────────────────────────────────────────────────────────────────────────
// 1. TOKEN BUCKET RATE LIMITER
// ─────────────────────────────────────────────────────────────────────────────

interface BucketConfig {
  capacity: number;     // max tokens
  refillRate: number;   // tokens per second
}

class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(private config: BucketConfig) {
    this.tokens = config.capacity;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000; // seconds
    const added = elapsed * this.config.refillRate;
    this.tokens = Math.min(this.config.capacity, this.tokens + added);
    this.lastRefill = now;
  }

  consume(tokens = 1): boolean {
    this.refill();
    if (this.tokens < tokens) return false;
    this.tokens -= tokens;
    return true;
  }

  get available(): number { this.refill(); return Math.floor(this.tokens); }
}

class RateLimiterMiddleware {
  private buckets = new Map<string, TokenBucket>();

  constructor(private defaultConfig: BucketConfig) {}

  check(tenantId: string, tokensNeeded = 1): { allowed: boolean; remaining: number } {
    if (!this.buckets.has(tenantId)) {
      this.buckets.set(tenantId, new TokenBucket(this.defaultConfig));
    }
    const bucket = this.buckets.get(tenantId)!;
    const allowed = bucket.consume(tokensNeeded);
    return { allowed, remaining: bucket.available };
  }

  configure(tenantId: string, config: BucketConfig): void {
    this.buckets.set(tenantId, new TokenBucket(config));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. SEMANTIC CACHE (mock — in production use vector similarity)
// ─────────────────────────────────────────────────────────────────────────────

interface CacheEntry {
  response: string;
  model: string;
  tokensUsed: number;
  createdAt: number;
  ttlMs: number;
}

function simpleHash(input: string): string {
  // FNV-1a for demo
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

class SemanticCache {
  private store = new Map<string, CacheEntry>();
  private hits = 0;
  private misses = 0;

  get(prompt: string, model: string): CacheEntry | null {
    const key = `${model}:${simpleHash(prompt.toLowerCase().trim())}`;
    const entry = this.store.get(key);
    if (!entry) { this.misses++; return null; }
    if (Date.now() - entry.createdAt > entry.ttlMs) {
      this.store.delete(key);
      this.misses++;
      return null;
    }
    this.hits++;
    return entry;
  }

  set(prompt: string, model: string, response: string, tokensUsed: number, ttlMs = 60_000): void {
    const key = `${model}:${simpleHash(prompt.toLowerCase().trim())}`;
    this.store.set(key, { response, model, tokensUsed, createdAt: Date.now(), ttlMs });
  }

  get stats() { return { hits: this.hits, misses: this.misses, size: this.store.size, hitRate: this.hits / Math.max(1, this.hits + this.misses) }; }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. MULTI-PROVIDER ROUTER WITH FALLBACK
// ─────────────────────────────────────────────────────────────────────────────

type Provider = "openai" | "anthropic" | "gemini" | "mistral";

interface ProviderCall {
  provider: Provider;
  model: string;
  prompt: string;
  maxTokens: number;
}

interface ProviderResponse {
  provider: Provider;
  content: string;
  tokensUsed: number;
  latencyMs: number;
  cost: number;
}

// Token pricing (per 1k tokens)
const PRICING: Record<Provider, { input: number; output: number }> = {
  openai:    { input: 0.005,  output: 0.015  },
  anthropic: { input: 0.008,  output: 0.024  },
  gemini:    { input: 0.00125,output: 0.005  },
  mistral:   { input: 0.002,  output: 0.006  },
};

function calculateCost(provider: Provider, inputTokens: number, outputTokens: number): number {
  const p = PRICING[provider];
  return (inputTokens * p.input + outputTokens * p.output) / 1000;
}

type MockProviderFn = (call: ProviderCall) => Promise<ProviderResponse>;

class MockProvider {
  static create(provider: Provider, failureRate = 0): MockProviderFn {
    return async (call: ProviderCall): Promise<ProviderResponse> => {
      if (Math.random() < failureRate) throw new Error(`${provider}: Service Unavailable`);
      const latencyMs = 100 + Math.random() * 200;
      await new Promise(r => setTimeout(r, latencyMs));
      const outputTokens = Math.floor(call.maxTokens * 0.6);
      const inputTokens  = Math.ceil(call.prompt.length / 4);
      return {
        provider,
        content: `[${provider}] ${call.prompt.slice(0, 50)}... (simulated response)`,
        tokensUsed: inputTokens + outputTokens,
        latencyMs: Math.round(latencyMs),
        cost: calculateCost(provider, inputTokens, outputTokens),
      };
    };
  }
}

class GatewayRouter {
  private providers: Map<Provider, MockProviderFn> = new Map();
  private fallbackChain: Provider[] = [];

  register(provider: Provider, fn: MockProviderFn, priority: number): void {
    this.providers.set(provider, fn);
    this.fallbackChain[priority] = provider;
    this.fallbackChain = this.fallbackChain.filter(Boolean);
  }

  async route(call: ProviderCall): Promise<ProviderResponse> {
    const preferredFn = this.providers.get(call.provider);
    if (preferredFn) {
      try { return await preferredFn(call); } catch { /* fall through */ }
    }

    for (const provider of this.fallbackChain) {
      if (provider === call.provider) continue;
      const fn = this.providers.get(provider);
      if (!fn) continue;
      try {
        const result = await fn({ ...call, provider });
        console.log(`  [Router] Fell back to ${provider} (preferred=${call.provider} failed)`);
        return result;
      } catch { /* try next */ }
    }
    throw new Error("All providers failed");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. GATEWAY MIDDLEWARE STACK
// ─────────────────────────────────────────────────────────────────────────────

interface GatewayRequest {
  tenantId: string;
  provider: Provider;
  model: string;
  prompt: string;
  maxTokens: number;
}

interface GatewayMiddlewareEvents {
  request:  [req: GatewayRequest];
  response: [req: GatewayRequest, res: ProviderResponse];
  blocked:  [req: GatewayRequest, reason: string];
  cacheHit: [req: GatewayRequest];
}

class AIGateway extends EventEmitter<GatewayMiddlewareEvents> {
  private rateLimiter = new RateLimiterMiddleware({ capacity: 10, refillRate: 2 });
  private cache = new SemanticCache();
  private router = new GatewayRouter();
  private costTracker = new Map<string, number>(); // tenantId → cumulative cost

  registerProvider(provider: Provider, fn: MockProviderFn, priority: number): void {
    this.router.register(provider, fn, priority);
  }

  async handle(req: GatewayRequest): Promise<ProviderResponse> {
    this.emit("request", req);

    // 1. Rate limiting
    const { allowed, remaining } = this.rateLimiter.check(req.tenantId);
    if (!allowed) {
      this.emit("blocked", req, "rate_limit");
      throw new Error(`Rate limit exceeded for tenant ${req.tenantId}`);
    }
    console.log(`  [RateLimit] tenant=${req.tenantId} remaining=${remaining}`);

    // 2. Semantic cache
    const cached = this.cache.get(req.prompt, req.model);
    if (cached) {
      this.emit("cacheHit", req);
      console.log(`  [Cache] HIT — saved ${cached.tokensUsed} tokens`);
      return { provider: req.provider, content: cached.response, tokensUsed: cached.tokensUsed, latencyMs: 0, cost: 0 };
    }

    // 3. Route to provider
    const response = await this.router.route({ provider: req.provider, model: req.model, prompt: req.prompt, maxTokens: req.maxTokens });

    // 4. Store in cache
    this.cache.set(req.prompt, req.model, response.content, response.tokensUsed);

    // 5. Track cost
    const prev = this.costTracker.get(req.tenantId) ?? 0;
    this.costTracker.set(req.tenantId, prev + response.cost);

    this.emit("response", req, response);
    return response;
  }

  getCosts(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [tenant, cost] of this.costTracker) result[tenant] = `$${cost.toFixed(6)}`;
    return result;
  }

  getCacheStats() { return this.cache.stats; }
}

// ─────────────────────────────────────────────────────────────────────────────
// DEMO / RUN
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n══════════════════════════════════════");
  console.log(" Bài 8: AI Gateway Design");
  console.log("══════════════════════════════════════\n");

  const gateway = new AIGateway();

  // Register providers (openai with 30% failure to demo fallback)
  gateway.registerProvider("openai",    MockProvider.create("openai",    0.3), 0);
  gateway.registerProvider("anthropic", MockProvider.create("anthropic", 0),   1);
  gateway.registerProvider("gemini",    MockProvider.create("gemini",    0),   2);

  gateway.on("response", (req, res) =>
    console.log(`  [Gateway] ✅ ${res.provider} | ${res.latencyMs}ms | ${res.tokensUsed} tokens | $${res.cost.toFixed(6)}`),
  );
  gateway.on("blocked", (req, reason) =>
    console.log(`  [Gateway] 🚫 Blocked tenant=${req.tenantId} reason=${reason}`),
  );

  // ── Normal requests ──
  console.log("[Normal Requests]");
  const prompts = [
    "Explain offline-first architecture",
    "What are CRDTs?",
    "How does vector clock work?",
  ];

  for (const prompt of prompts) {
    try {
      const res = await gateway.handle({ tenantId: "tenant_a", provider: "openai", model: "gpt-4o", prompt, maxTokens: 512 });
      console.log(`    → ${res.content.slice(0, 60)}...`);
    } catch (err) {
      console.log(`    ❌ ${(err as Error).message}`);
    }
  }

  // ── Cache hit ──
  console.log("\n[Cache Hit]");
  await gateway.handle({ tenantId: "tenant_a", provider: "openai", model: "gpt-4o", prompt: "Explain offline-first architecture", maxTokens: 512 });

  // ── Rate limiting: configure tight limit for tenant_b ──
  console.log("\n[Rate Limiting]");
  gateway["rateLimiter"].configure("tenant_b", { capacity: 2, refillRate: 0.5 });
  for (let i = 0; i < 4; i++) {
    try {
      await gateway.handle({ tenantId: "tenant_b", provider: "gemini", model: "gemini-pro", prompt: `Query ${i}`, maxTokens: 128 });
    } catch (err) {
      console.log(`  ❌ ${(err as Error).message}`);
    }
  }

  // ── Cost summary ──
  console.log("\n[Cost Tracking]");
  console.log("  Costs by tenant:", gateway.getCosts());
  console.log("  Cache stats:", gateway.getCacheStats());

  console.log("\n✅ Bài 8 hoàn thành!\n");
}

main().catch(console.error);

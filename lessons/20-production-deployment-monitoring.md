# Bài 20: Production Deployment & Monitoring

## Mục tiêu bài học

- Kubernetes deployment cho AI microservices với TypeScript
- Observability: OpenTelemetry tracing, metrics, logging
- Cost optimization: token budgets, caching strategies
- Zero-downtime deployment với canary releases
- AI-specific monitoring: hallucination detection, drift monitoring

---

## 20.1 Production Configuration Management

```typescript
import { z } from "zod";

// Strict runtime config validation
const ProductionConfigSchema = z.object({
  server: z.object({
    port: z.number().int().min(1024).max(65535).default(8080),
    host: z.string().default("0.0.0.0"),
    requestTimeoutMs: z.number().default(30000),
    bodyLimitMb: z.number().default(10),
  }),
  
  ai: z.object({
    providers: z.array(z.object({
      name: z.enum(["openai", "anthropic", "cohere", "local"]),
      apiKey: z.string().min(1),
      baseUrl: z.string().url().optional(),
      maxRetries: z.number().int().default(3),
      timeoutMs: z.number().default(60000),
    })),
    defaultProvider: z.string(),
    defaultModel: z.string(),
    maxTokensPerRequest: z.number().int().default(4096),
  }),
  
  database: z.object({
    host: z.string(),
    port: z.number().int().default(5432),
    name: z.string(),
    user: z.string(),
    password: z.string(),
    poolSize: z.number().int().default(20),
    ssl: z.boolean().default(true),
  }),
  
  redis: z.object({
    host: z.string(),
    port: z.number().int().default(6379),
    password: z.string().optional(),
    db: z.number().int().default(0),
    tls: z.boolean().default(false),
  }),
  
  vectorDb: z.object({
    provider: z.enum(["pinecone", "weaviate", "chroma"]),
    apiKey: z.string().optional(),
    host: z.string().optional(),
    indexName: z.string(),
  }),
  
  monitoring: z.object({
    otlpEndpoint: z.string().url().optional(),
    serviceName: z.string().default("ai-service"),
    serviceVersion: z.string().default("1.0.0"),
    logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
    sampleRate: z.number().min(0).max(1).default(0.1),
  }),
  
  rateLimiting: z.object({
    requestsPerMinute: z.number().int().default(60),
    tokensPerMinute: z.number().int().default(100000),
    burstCapacity: z.number().int().default(100),
  }),
  
  featureFlags: z.record(z.boolean()).default({}),
});

type ProductionConfig = z.infer<typeof ProductionConfigSchema>;

class ConfigManager {
  private config: ProductionConfig;

  constructor() {
    this.config = this.loadAndValidate();
  }

  private loadAndValidate(): ProductionConfig {
    const raw = {
      server: {
        port: parseInt(process.env.PORT ?? "8080"),
        host: process.env.HOST,
        requestTimeoutMs: parseInt(process.env.REQUEST_TIMEOUT_MS ?? "30000"),
      },
      ai: {
        providers: [
          {
            name: "openai" as const,
            apiKey: process.env.OPENAI_API_KEY ?? "",
            maxRetries: 3,
          },
        ],
        defaultProvider: process.env.DEFAULT_AI_PROVIDER ?? "openai",
        defaultModel: process.env.DEFAULT_MODEL ?? "gpt-4o-mini",
        maxTokensPerRequest: 4096,
      },
      database: {
        host: process.env.DB_HOST ?? "localhost",
        port: parseInt(process.env.DB_PORT ?? "5432"),
        name: process.env.DB_NAME ?? "aiapp",
        user: process.env.DB_USER ?? "postgres",
        password: process.env.DB_PASSWORD ?? "",
        poolSize: parseInt(process.env.DB_POOL_SIZE ?? "20"),
        ssl: process.env.NODE_ENV === "production",
      },
      redis: {
        host: process.env.REDIS_HOST ?? "localhost",
        port: parseInt(process.env.REDIS_PORT ?? "6379"),
        password: process.env.REDIS_PASSWORD,
        db: parseInt(process.env.REDIS_DB ?? "0"),
        tls: process.env.NODE_ENV === "production",
      },
      vectorDb: {
        provider: (process.env.VECTOR_DB_PROVIDER ?? "pinecone") as "pinecone",
        apiKey: process.env.PINECONE_API_KEY,
        indexName: process.env.PINECONE_INDEX ?? "ai-app",
      },
      monitoring: {
        otlpEndpoint: process.env.OTLP_ENDPOINT,
        serviceName: process.env.SERVICE_NAME ?? "ai-service",
        serviceVersion: process.env.npm_package_version ?? "1.0.0",
        logLevel: (process.env.LOG_LEVEL ?? "info") as "info",
        sampleRate: parseFloat(process.env.TRACE_SAMPLE_RATE ?? "0.1"),
      },
      rateLimiting: {
        requestsPerMinute: parseInt(process.env.RATE_LIMIT_RPM ?? "60"),
        tokensPerMinute: parseInt(process.env.RATE_LIMIT_TPM ?? "100000"),
        burstCapacity: parseInt(process.env.RATE_LIMIT_BURST ?? "100"),
      },
      featureFlags: this.parseFeatureFlags(),
    };

    const result = ProductionConfigSchema.safeParse(raw);
    if (!result.success) {
      const errors = result.error.errors
        .map((e) => `${e.path.join(".")}: ${e.message}`)
        .join("\n");
      throw new Error(`Invalid configuration:\n${errors}`);
    }

    return result.data;
  }

  private parseFeatureFlags(): Record<string, boolean> {
    const flags: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith("FEATURE_")) {
        const flagName = key.slice(8).toLowerCase().replace(/_/g, ".");
        flags[flagName] = value === "true";
      }
    }
    return flags;
  }

  get<K extends keyof ProductionConfig>(key: K): ProductionConfig[K] {
    return this.config[key];
  }

  isFeatureEnabled(flag: string): boolean {
    return this.config.featureFlags[flag] ?? false;
  }
}
```

---

## 20.2 OpenTelemetry Observability

```typescript
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { Resource } from "@opentelemetry/resources";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { trace, metrics, context, SpanStatusCode } from "@opentelemetry/api";
import type { Tracer, Meter } from "@opentelemetry/api";

// Initialize OpenTelemetry
function initTelemetry(config: {
  serviceName: string;
  serviceVersion: string;
  otlpEndpoint?: string;
  sampleRate: number;
}): void {
  const sdk = new NodeSDK({
    resource: new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: config.serviceName,
      [SemanticResourceAttributes.SERVICE_VERSION]: config.serviceVersion,
    }),
    traceExporter: new OTLPTraceExporter({
      url: config.otlpEndpoint
        ? `${config.otlpEndpoint}/v1/traces`
        : "http://localhost:4318/v1/traces",
    }),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({
        url: config.otlpEndpoint
          ? `${config.otlpEndpoint}/v1/metrics`
          : "http://localhost:4318/v1/metrics",
      }),
      exportIntervalMillis: 10000,
    }),
  });

  sdk.start();
  console.log("OpenTelemetry initialized");
}

// AI-specific telemetry
class AITelemetry {
  private tracer: Tracer;
  private meter: Meter;

  // Metrics
  private llmRequestDuration: ReturnType<Meter["createHistogram"]>;
  private llmTokensCounter: ReturnType<Meter["createCounter"]>;
  private llmRequestErrors: ReturnType<Meter["createCounter"]>;
  private ragRetrievalDuration: ReturnType<Meter["createHistogram"]>;
  private cacheHitRate: ReturnType<Meter["createObservableGauge"]>;
  private activeConnections: ReturnType<Meter["createUpDownCounter"]>;

  private cacheHits = 0;
  private cacheMisses = 0;

  constructor(serviceName: string) {
    this.tracer = trace.getTracer(serviceName);
    this.meter = metrics.getMeter(serviceName);

    this.llmRequestDuration = this.meter.createHistogram("llm.request.duration", {
      description: "LLM request duration",
      unit: "ms",
    });

    this.llmTokensCounter = this.meter.createCounter("llm.tokens.total", {
      description: "Total tokens used",
      unit: "tokens",
    });

    this.llmRequestErrors = this.meter.createCounter("llm.request.errors", {
      description: "LLM request errors",
    });

    this.ragRetrievalDuration = this.meter.createHistogram("rag.retrieval.duration", {
      description: "RAG retrieval duration",
      unit: "ms",
    });

    this.cacheHitRate = this.meter.createObservableGauge("cache.hit_rate", {
      description: "Cache hit rate",
    });

    this.cacheHitRate.addCallback((result) => {
      const total = this.cacheHits + this.cacheMisses;
      result.observe(total > 0 ? this.cacheHits / total : 0);
    });

    this.activeConnections = this.meter.createUpDownCounter("connections.active", {
      description: "Active WebSocket connections",
    });
  }

  async traceLLMRequest<T>(
    fn: () => Promise<T>,
    attributes: {
      model: string;
      provider: string;
      userId?: string;
      cached?: boolean;
    }
  ): Promise<T> {
    return this.tracer.startActiveSpan("llm.request", async (span) => {
      span.setAttributes({
        "llm.model": attributes.model,
        "llm.provider": attributes.provider,
        "user.id": attributes.userId ?? "anonymous",
        "llm.cached": attributes.cached ?? false,
      });

      const start = Date.now();
      try {
        const result = await fn();
        const duration = Date.now() - start;

        this.llmRequestDuration.record(duration, {
          model: attributes.model,
          provider: attributes.provider,
          status: "success",
        });

        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error),
        });
        span.recordException(error as Error);

        this.llmRequestErrors.add(1, {
          model: attributes.model,
          provider: attributes.provider,
          error_type: error instanceof Error ? error.name : "UnknownError",
        });

        throw error;
      } finally {
        span.end();
      }
    });
  }

  recordTokenUsage(
    promptTokens: number,
    completionTokens: number,
    model: string
  ): void {
    this.llmTokensCounter.add(promptTokens, { model, type: "prompt" });
    this.llmTokensCounter.add(completionTokens, { model, type: "completion" });
  }

  recordCacheHit(hit: boolean): void {
    if (hit) {
      this.cacheHits++;
    } else {
      this.cacheMisses++;
    }
  }

  trackConnection(delta: 1 | -1): void {
    this.activeConnections.add(delta);
  }
}

// Structured logging
interface LogEntry {
  timestamp: string;
  level: "debug" | "info" | "warn" | "error";
  service: string;
  requestId?: string;
  userId?: string;
  message: string;
  data?: Record<string, unknown>;
  error?: { message: string; stack?: string; code?: string };
  duration?: number;
}

class StructuredLogger {
  constructor(
    private serviceName: string,
    private level: "debug" | "info" | "warn" | "error" = "info"
  ) {}

  private shouldLog(level: LogEntry["level"]): boolean {
    const levels = ["debug", "info", "warn", "error"];
    return levels.indexOf(level) >= levels.indexOf(this.level);
  }

  private log(entry: Omit<LogEntry, "timestamp" | "service">): void {
    if (!this.shouldLog(entry.level)) return;

    const logEntry: LogEntry = {
      timestamp: new Date().toISOString(),
      service: this.serviceName,
      ...entry,
    };

    // JSON structured logging for log aggregation (Loki, CloudWatch)
    const output = JSON.stringify(logEntry);
    
    if (entry.level === "error") {
      process.stderr.write(output + "\n");
    } else {
      process.stdout.write(output + "\n");
    }
  }

  info(message: string, data?: Record<string, unknown>, context?: { requestId?: string; userId?: string }): void {
    this.log({ level: "info", message, data, ...context });
  }

  warn(message: string, data?: Record<string, unknown>, context?: { requestId?: string; userId?: string }): void {
    this.log({ level: "warn", message, data, ...context });
  }

  error(message: string, error?: Error, data?: Record<string, unknown>, context?: { requestId?: string; userId?: string }): void {
    this.log({
      level: "error",
      message,
      error: error
        ? { message: error.message, stack: error.stack, code: (error as NodeJS.ErrnoException).code }
        : undefined,
      data,
      ...context,
    });
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.log({ level: "debug", message, data });
  }
}
```

---

## 20.3 Kubernetes Deployment Manifests

```yaml
# k8s/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ai-service
  labels:
    app: ai-service
    version: "1.0.0"
spec:
  replicas: 3
  selector:
    matchLabels:
      app: ai-service
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0          # Zero-downtime deployment
  template:
    metadata:
      labels:
        app: ai-service
        version: "1.0.0"
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "9090"
    spec:
      serviceAccountName: ai-service
      containers:
        - name: ai-service
          image: ai-service:latest
          ports:
            - containerPort: 8080
              name: http
            - containerPort: 9090
              name: metrics
            - containerPort: 50051
              name: grpc
          env:
            - name: NODE_ENV
              value: production
            - name: PORT
              value: "8080"
            - name: OPENAI_API_KEY
              valueFrom:
                secretKeyRef:
                  name: ai-service-secrets
                  key: openai-api-key
            - name: DB_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: ai-service-secrets
                  key: db-password
            - name: OTLP_ENDPOINT
              value: "http://otel-collector:4318"
          resources:
            requests:
              cpu: "500m"
              memory: "512Mi"
            limits:
              cpu: "2000m"
              memory: "2Gi"
          livenessProbe:
            httpGet:
              path: /health/live
              port: 8080
            initialDelaySeconds: 30
            periodSeconds: 10
            failureThreshold: 3
          readinessProbe:
            httpGet:
              path: /health/ready
              port: 8080
            initialDelaySeconds: 10
            periodSeconds: 5
          startupProbe:
            httpGet:
              path: /health/startup
              port: 8080
            failureThreshold: 30
            periodSeconds: 10
```

---

## 20.4 Health Check Endpoints

```typescript
import http from "http";

interface HealthStatus {
  status: "healthy" | "degraded" | "unhealthy";
  timestamp: string;
  version: string;
  checks: Record<string, ComponentHealth>;
  uptime: number;
}

interface ComponentHealth {
  status: "healthy" | "degraded" | "unhealthy";
  latencyMs?: number;
  message?: string;
  lastChecked: string;
}

class HealthCheckService {
  private startTime = Date.now();
  private lastChecks: Record<string, ComponentHealth> = {};

  constructor(
    private services: {
      db: { query(sql: string): Promise<unknown> };
      redis: { ping(): Promise<string> };
      vectorDb: { ping(): Promise<boolean> };
      llm: { complete(messages: unknown[]): Promise<unknown> };
    }
  ) {}

  async getLivenessStatus(): Promise<{ status: string; uptime: number }> {
    // Just check if the process is alive
    return { status: "alive", uptime: Date.now() - this.startTime };
  }

  async getReadinessStatus(): Promise<HealthStatus> {
    const checks: Record<string, ComponentHealth> = {};
    
    await Promise.all([
      this.checkDatabase().then((r) => { checks.database = r; }),
      this.checkRedis().then((r) => { checks.redis = r; }),
      this.checkVectorDB().then((r) => { checks.vectorDb = r; }),
    ]);

    const statuses = Object.values(checks).map((c) => c.status);
    const overallStatus: HealthStatus["status"] =
      statuses.every((s) => s === "healthy") ? "healthy" :
      statuses.some((s) => s === "unhealthy") ? "unhealthy" : "degraded";

    this.lastChecks = checks;

    return {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      version: process.env.npm_package_version ?? "unknown",
      checks,
      uptime: Date.now() - this.startTime,
    };
  }

  private async checkDatabase(): Promise<ComponentHealth> {
    const start = Date.now();
    try {
      await this.services.db.query("SELECT 1");
      return {
        status: "healthy",
        latencyMs: Date.now() - start,
        lastChecked: new Date().toISOString(),
      };
    } catch (error) {
      return {
        status: "unhealthy",
        message: error instanceof Error ? error.message : String(error),
        lastChecked: new Date().toISOString(),
      };
    }
  }

  private async checkRedis(): Promise<ComponentHealth> {
    const start = Date.now();
    try {
      const result = await this.services.redis.ping();
      return {
        status: result === "PONG" ? "healthy" : "degraded",
        latencyMs: Date.now() - start,
        lastChecked: new Date().toISOString(),
      };
    } catch (error) {
      return {
        status: "unhealthy",
        message: error instanceof Error ? error.message : String(error),
        lastChecked: new Date().toISOString(),
      };
    }
  }

  private async checkVectorDB(): Promise<ComponentHealth> {
    const start = Date.now();
    try {
      const ok = await this.services.vectorDb.ping();
      return {
        status: ok ? "healthy" : "degraded",
        latencyMs: Date.now() - start,
        lastChecked: new Date().toISOString(),
      };
    } catch (error) {
      return {
        status: "unhealthy",
        message: error instanceof Error ? error.message : String(error),
        lastChecked: new Date().toISOString(),
      };
    }
  }
}

// Graceful shutdown
class GracefulShutdown {
  private isShuttingDown = false;
  private activeRequests = 0;

  constructor(
    private server: http.Server,
    private cleanupFns: Array<() => Promise<void>>
  ) {
    process.on("SIGTERM", () => this.shutdown("SIGTERM"));
    process.on("SIGINT", () => this.shutdown("SIGINT"));
  }

  trackRequest(): () => void {
    this.activeRequests++;
    return () => {
      this.activeRequests--;
    };
  }

  isShutdown(): boolean {
    return this.isShuttingDown;
  }

  private async shutdown(signal: string): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    
    console.log(`[Shutdown] Received ${signal}, starting graceful shutdown`);

    // Stop accepting new connections
    this.server.close(() => {
      console.log("[Shutdown] HTTP server closed");
    });

    // Wait for active requests (max 30s)
    const maxWait = 30000;
    const start = Date.now();
    while (this.activeRequests > 0 && Date.now() - start < maxWait) {
      console.log(`[Shutdown] Waiting for ${this.activeRequests} active requests...`);
      await new Promise((r) => setTimeout(r, 1000));
    }

    // Run cleanup functions
    console.log("[Shutdown] Running cleanup functions...");
    await Promise.allSettled(this.cleanupFns.map((fn) => fn()));

    console.log("[Shutdown] Complete");
    process.exit(0);
  }
}
```

---

## 20.5 Cost Monitoring & Optimization

```typescript
// Token cost tracker
interface CostEntry {
  timestamp: Date;
  userId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalCostUSD: number;
  requestId: string;
}

class CostTracker {
  private entries: CostEntry[] = [];
  
  // Cost per 1k tokens (approximate)
  private readonly modelCosts: Record<string, { input: number; output: number }> = {
    "gpt-4o": { input: 0.005, output: 0.015 },
    "gpt-4o-mini": { input: 0.00015, output: 0.0006 },
    "claude-3-5-sonnet": { input: 0.003, output: 0.015 },
    "claude-3-haiku": { input: 0.00025, output: 0.00125 },
  };

  record(entry: Omit<CostEntry, "timestamp" | "totalCostUSD">): CostEntry {
    const costs = this.modelCosts[entry.model] ?? { input: 0.005, output: 0.015 };
    const totalCostUSD =
      (entry.promptTokens / 1000) * costs.input +
      (entry.completionTokens / 1000) * costs.output;

    const full: CostEntry = {
      ...entry,
      timestamp: new Date(),
      totalCostUSD,
    };

    this.entries.push(full);
    return full;
  }

  getUserCost(userId: string, periodMs: number = 30 * 24 * 60 * 60 * 1000): {
    totalCostUSD: number;
    totalTokens: number;
    requestCount: number;
    byModel: Record<string, { cost: number; tokens: number }>;
  } {
    const cutoff = new Date(Date.now() - periodMs);
    const userEntries = this.entries.filter(
      (e) => e.userId === userId && e.timestamp >= cutoff
    );

    const byModel: Record<string, { cost: number; tokens: number }> = {};
    let totalCostUSD = 0;
    let totalTokens = 0;

    for (const entry of userEntries) {
      totalCostUSD += entry.totalCostUSD;
      totalTokens += entry.promptTokens + entry.completionTokens;
      
      if (!byModel[entry.model]) {
        byModel[entry.model] = { cost: 0, tokens: 0 };
      }
      byModel[entry.model].cost += entry.totalCostUSD;
      byModel[entry.model].tokens += entry.promptTokens + entry.completionTokens;
    }

    return {
      totalCostUSD,
      totalTokens,
      requestCount: userEntries.length,
      byModel,
    };
  }

  getTopSpenders(limit: number = 10): Array<{ userId: string; totalCostUSD: number }> {
    const userCosts = new Map<string, number>();
    for (const entry of this.entries) {
      userCosts.set(entry.userId, (userCosts.get(entry.userId) ?? 0) + entry.totalCostUSD);
    }
    return Array.from(userCosts.entries())
      .map(([userId, totalCostUSD]) => ({ userId, totalCostUSD }))
      .sort((a, b) => b.totalCostUSD - a.totalCostUSD)
      .slice(0, limit);
  }
}
```

---

## Tóm tắt Toàn Khóa Học

### 20 Bài Học — Roadmap Hoàn Chỉnh

```
Bài 1-5: Foundation
├── TypeScript Advanced Types
├── Offline-First Architecture
├── Local Data Layer (IndexedDB/PouchDB)
├── CRDTs (Conflict-Free Data)
└── Service Workers & Background Sync

Bài 6-10: Distributed Systems
├── Distributed Systems Fundamentals
├── Event Sourcing & CQRS
├── AI Gateway Design
├── LLM Orchestration
└── Real-time Sync (WebSocket/SSE)

Bài 11-14: Infrastructure
├── Fault Tolerance (Circuit Breaker, Retry)
├── Cross-Platform Mobile (React Native)
├── GraphQL API Gateway
└── gRPC & Protocol Buffers

Bài 15-18: AI Engineering
├── Vector Databases & Semantic Search
├── RAG Implementation
├── AI Agent Architecture
└── Multi-Agent Orchestration

Bài 19-20: Production
├── Testing AI Systems
└── Production Deployment & Monitoring
```

### Kiến Trúc Tổng Thể

```
Mobile (React Native) ──┐
Web (React)             ├──► GraphQL/gRPC Gateway
                        │         │
                        │    ┌────▼────┐
                        │    │ AI      │◄── OpenAI/Anthropic
                        └──► │ Gateway │◄── Local LLM (Ollama)
                             └────┬────┘
                                  │
               ┌──────────────────┼──────────────────┐
               │                  │                  │
          ┌────▼────┐        ┌────▼────┐        ┌────▼────┐
          │ Event   │        │ Vector  │        │ Agent   │
          │ Store   │        │   DB    │        │System   │
          │(CQRS)   │        │(Pinecone│        │(ReAct)  │
          └─────────┘        └─────────┘        └─────────┘
               │                  │                  │
          ┌────▼────────────────────────────────────▼────┐
          │              Offline Sync Layer               │
          │    (CRDTs + Service Workers + Background Sync)│
          └───────────────────────────────────────────────┘
```

## Bài tập cuối khóa

1. **Capstone Project**: Xây dựng offline-first AI knowledge base với full pipeline:
   - Document upload → chunking → embedding → Pinecone
   - Hybrid search (vector + BM25)
   - Multi-agent Q&A (researcher + reviewer)
   - Real-time streaming với WebSocket
   - Service Worker caching
   - React Native mobile app

2. **Production Deployment**: Deploy lên Kubernetes với:
   - Canary deployment (10% traffic mới)
   - OpenTelemetry tracing
   - Cost monitoring dashboard
   - Auto-scaling dựa trên token usage

---

*🎉 Chúc mừng bạn đã hoàn thành 20 bài học về TypeScript Offline-First AI Systems!*

*Repo này được thiết kế như tài liệu tham khảo. Mỗi bài học có thể được đọc độc lập hoặc kết hợp với nhau để xây dựng full-stack AI applications.*

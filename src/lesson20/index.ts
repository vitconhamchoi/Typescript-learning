/**
 * Bài 20: Production Deployment & Monitoring
 * =============================================
 * Chạy: npm run lesson20
 *
 * Nội dung:
 *  - OpenTelemetry-style tracing & metrics
 *  - Cost tracking & budget alerts
 *  - Graceful shutdown
 *  - Health check endpoint
 *  - Kubernetes manifest types
 *  - Feature flags
 *  - Structured logging (pino-style)
 */

import { EventEmitter } from "eventemitter3";

// ─────────────────────────────────────────────────────────────────────────────
// 1. STRUCTURED LOGGING (pino-compatible interface)
// ─────────────────────────────────────────────────────────────────────────────

type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

interface LogRecord {
  level:     LogLevel;
  msg:       string;
  time:      number;
  pid:       number;
  hostname:  string;
  [key: string]: unknown;
}

class StructuredLogger {
  private readonly context: Record<string, unknown>;
  private logFn: (record: LogRecord) => void;

  constructor(context: Record<string, unknown> = {}, logFn?: (r: LogRecord) => void) {
    this.context = context;
    this.logFn   = logFn ?? ((r) => {
      const { level, msg, time, ...rest } = r;
      const extra = Object.keys(rest).filter(k => !["pid","hostname"].includes(k));
      const meta  = extra.map(k => `${k}=${JSON.stringify(rest[k])}`).join(" ");
      console.log(`[${new Date(time).toISOString()}] ${level.toUpperCase().padEnd(5)} ${msg}${meta ? " | " + meta : ""}`);
    });
  }

  child(bindings: Record<string, unknown>): StructuredLogger {
    return new StructuredLogger({ ...this.context, ...bindings }, this.logFn);
  }

  private log(level: LogLevel, msg: string, extra: Record<string, unknown> = {}): void {
    this.logFn({
      level, msg,
      time:     Date.now(),
      pid:      process.pid,
      hostname: "localhost",
      ...this.context,
      ...extra,
    });
  }

  trace(msg: string, ctx?: Record<string, unknown>): void { this.log("trace", msg, ctx); }
  debug(msg: string, ctx?: Record<string, unknown>): void { this.log("debug", msg, ctx); }
  info (msg: string, ctx?: Record<string, unknown>): void { this.log("info",  msg, ctx); }
  warn (msg: string, ctx?: Record<string, unknown>): void { this.log("warn",  msg, ctx); }
  error(msg: string, ctx?: Record<string, unknown>): void { this.log("error", msg, ctx); }
  fatal(msg: string, ctx?: Record<string, unknown>): void { this.log("fatal", msg, ctx); }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. OPENTELEMETRY-STYLE METRICS
// ─────────────────────────────────────────────────────────────────────────────

interface MetricAttributes { [key: string]: string | number | boolean }

class Counter {
  private value = 0;
  constructor(readonly name: string, readonly description: string) {}
  add(n = 1, _attrs?: MetricAttributes): void { this.value += n; }
  get(): number { return this.value; }
}

class Histogram {
  private samples: number[] = [];
  constructor(readonly name: string, readonly description: string, readonly boundaries: number[]) {}

  record(value: number, _attrs?: MetricAttributes): void { this.samples.push(value); }

  summary(): { count: number; sum: number; p50: number; p95: number; p99: number } {
    if (this.samples.length === 0) return { count: 0, sum: 0, p50: 0, p95: 0, p99: 0 };
    const sorted = [...this.samples].sort((a, b) => a - b);
    const p = (pct: number) => sorted[Math.floor(sorted.length * pct)] ?? 0;
    return {
      count: sorted.length,
      sum:   sorted.reduce((a, b) => a + b, 0),
      p50:   p(0.5),
      p95:   p(0.95),
      p99:   p(0.99),
    };
  }
}

class Gauge {
  private value = 0;
  constructor(readonly name: string, readonly description: string) {}
  set(v: number, _attrs?: MetricAttributes): void { this.value = v; }
  get(): number { return this.value; }
}

class MetricsRegistry {
  private counters   = new Map<string, Counter>();
  private histograms = new Map<string, Histogram>();
  private gauges     = new Map<string, Gauge>();

  counter(name: string, description: string): Counter {
    if (!this.counters.has(name)) this.counters.set(name, new Counter(name, description));
    return this.counters.get(name)!;
  }

  histogram(name: string, description: string, boundaries = [10, 50, 100, 500, 1000, 5000]): Histogram {
    if (!this.histograms.has(name)) this.histograms.set(name, new Histogram(name, description, boundaries));
    return this.histograms.get(name)!;
  }

  gauge(name: string, description: string): Gauge {
    if (!this.gauges.has(name)) this.gauges.set(name, new Gauge(name, description));
    return this.gauges.get(name)!;
  }

  export(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [k, v] of this.counters)   result[k] = v.get();
    for (const [k, v] of this.gauges)     result[k] = v.get();
    for (const [k, v] of this.histograms) result[k] = v.summary();
    return result;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. COST TRACKER WITH BUDGET ALERTS
// ─────────────────────────────────────────────────────────────────────────────

interface CostEntry {
  tenantId:    string;
  model:       string;
  inputTokens: number;
  outputTokens: number;
  costUSD:     number;
  timestamp:   number;
}

const PRICING_PER_1K: Record<string, { input: number; output: number }> = {
  "gpt-4o":             { input: 0.005,   output: 0.015   },
  "gpt-4o-mini":        { input: 0.00015, output: 0.0006  },
  "claude-3-5-sonnet":  { input: 0.003,   output: 0.015   },
  "gemini-1.5-pro":     { input: 0.00125, output: 0.005   },
};

class CostTracker {
  private entries: CostEntry[] = [];
  private budgets  = new Map<string, number>(); // tenantId → monthly budget USD

  private readonly alertCallbacks: Array<(tenantId: string, spent: number, budget: number) => void> = [];

  setBudget(tenantId: string, monthlyBudgetUSD: number): void {
    this.budgets.set(tenantId, monthlyBudgetUSD);
  }

  onBudgetAlert(cb: (tenantId: string, spent: number, budget: number) => void): void {
    this.alertCallbacks.push(cb);
  }

  record(tenantId: string, model: string, inputTokens: number, outputTokens: number): number {
    const pricing = PRICING_PER_1K[model] ?? { input: 0.001, output: 0.002 };
    const costUSD = (inputTokens * pricing.input + outputTokens * pricing.output) / 1000;
    this.entries.push({ tenantId, model, inputTokens, outputTokens, costUSD, timestamp: Date.now() });

    const budget = this.budgets.get(tenantId);
    if (budget) {
      const spent = this.tenantCost(tenantId);
      const pct   = spent / budget;
      if (pct >= 0.9) this.alertCallbacks.forEach(cb => cb(tenantId, spent, budget));
    }
    return costUSD;
  }

  tenantCost(tenantId: string, sinceMs?: number): number {
    return this.entries
      .filter(e => e.tenantId === tenantId && (sinceMs === undefined || e.timestamp >= sinceMs))
      .reduce((sum, e) => sum + e.costUSD, 0);
  }

  topModels(): Array<{ model: string; totalCost: number; calls: number }> {
    const agg = new Map<string, { cost: number; calls: number }>();
    for (const e of this.entries) {
      const cur = agg.get(e.model) ?? { cost: 0, calls: 0 };
      agg.set(e.model, { cost: cur.cost + e.costUSD, calls: cur.calls + 1 });
    }
    return [...agg.entries()]
      .map(([model, { cost, calls }]) => ({ model, totalCost: cost, calls }))
      .sort((a, b) => b.totalCost - a.totalCost);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. HEALTH CHECK
// ─────────────────────────────────────────────────────────────────────────────

type HealthStatus = "healthy" | "degraded" | "unhealthy";

interface ComponentHealth {
  name:    string;
  status:  HealthStatus;
  latencyMs?: number;
  error?:  string;
}

interface HealthReport {
  status:     HealthStatus;
  components: ComponentHealth[];
  timestamp:  string;
  version:    string;
}

type HealthCheckFn = () => Promise<ComponentHealth>;

class HealthChecker {
  private checks: Map<string, HealthCheckFn> = new Map();

  register(name: string, fn: HealthCheckFn): void { this.checks.set(name, fn); }

  async check(): Promise<HealthReport> {
    const components: ComponentHealth[] = await Promise.all(
      [...this.checks.entries()].map(async ([name, fn]) => {
        const start = Date.now();
        try {
          const result = await Promise.race([
            fn(),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
          ]);
          return { ...result, name, latencyMs: Date.now() - start };
        } catch (err) {
          return { name, status: "unhealthy" as HealthStatus, latencyMs: Date.now() - start, error: String(err) };
        }
      }),
    );

    const status: HealthStatus = components.some(c => c.status === "unhealthy")
      ? "unhealthy"
      : components.some(c => c.status === "degraded")
      ? "degraded"
      : "healthy";

    return { status, components, timestamp: new Date().toISOString(), version: "1.0.0" };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. FEATURE FLAGS
// ─────────────────────────────────────────────────────────────────────────────

interface FeatureFlag {
  name:        string;
  enabled:     boolean;
  rolloutPct?: number; // 0-100
  allowlist?:  string[]; // specific tenantIds
}

class FeatureFlagService {
  private flags = new Map<string, FeatureFlag>();

  define(flag: FeatureFlag): void { this.flags.set(flag.name, flag); }

  isEnabled(name: string, context: { tenantId?: string; userId?: string }): boolean {
    const flag = this.flags.get(name);
    if (!flag || !flag.enabled) return false;
    if (flag.allowlist && context.tenantId && flag.allowlist.includes(context.tenantId)) return true;
    if (flag.rolloutPct !== undefined) {
      // Deterministic rollout based on tenantId hash
      const hash = (context.tenantId ?? "").split("").reduce((h, c) => Math.imul(31, h) + c.charCodeAt(0) | 0, 0);
      return (Math.abs(hash) % 100) < flag.rolloutPct;
    }
    return flag.enabled;
  }

  getAll(): FeatureFlag[] { return [...this.flags.values()]; }
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. GRACEFUL SHUTDOWN
// ─────────────────────────────────────────────────────────────────────────────

type ShutdownHandler = () => Promise<void>;

class GracefulShutdown extends EventEmitter<{ shutdown: [] }> {
  private handlers: Array<{ name: string; fn: ShutdownHandler }> = [];
  private shutdownStarted = false;

  register(name: string, fn: ShutdownHandler): void {
    this.handlers.push({ name, fn });
  }

  async shutdown(signal: string): Promise<void> {
    if (this.shutdownStarted) return;
    this.shutdownStarted = true;
    this.emit("shutdown");

    console.log(`\n  [Shutdown] Signal: ${signal} — starting graceful shutdown`);
    for (const { name, fn } of this.handlers) {
      try {
        console.log(`  [Shutdown] Closing: ${name}`);
        await fn();
        console.log(`  [Shutdown] ✅ ${name} closed`);
      } catch (err) {
        console.log(`  [Shutdown] ❌ ${name} error: ${err}`);
      }
    }
    console.log("  [Shutdown] ✅ Graceful shutdown complete");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DEMO / RUN
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n══════════════════════════════════════");
  console.log(" Bài 20: Production Deployment & Monitoring");
  console.log("══════════════════════════════════════\n");

  // ── Logging ──
  console.log("[Structured Logging]");
  const logger = new StructuredLogger({ service: "ai-gateway", version: "1.0.0" });
  logger.info("Gateway starting", { port: 3000 });
  logger.warn("Rate limit approaching", { tenantId: "tenant_a", used: 90, limit: 100 });
  logger.error("Provider timeout", { provider: "openai", durationMs: 30000 });
  const reqLogger = logger.child({ requestId: "req_abc123", tenantId: "tenant_b" });
  reqLogger.info("Request received", { model: "gpt-4o", tokens: 512 });

  // ── Metrics ──
  console.log("\n[OpenTelemetry-style Metrics]");
  const metrics = new MetricsRegistry();
  const requestCounter = metrics.counter("ai.requests.total", "Total AI requests");
  const latencyHist    = metrics.histogram("ai.latency.ms", "Request latency");
  const activeConns    = metrics.gauge("ai.connections.active", "Active connections");

  // Simulate some traffic
  for (let i = 0; i < 20; i++) {
    requestCounter.add(1, { model: i % 2 === 0 ? "gpt-4o" : "gemini" });
    latencyHist.record(50 + Math.random() * 200);
    activeConns.set(Math.floor(Math.random() * 50));
  }

  const exported = metrics.export();
  console.log("  Metrics snapshot:");
  console.log(`    ai.requests.total: ${exported["ai.requests.total"]}`);
  console.log(`    ai.latency.ms:`, exported["ai.latency.ms"]);
  console.log(`    ai.connections.active: ${exported["ai.connections.active"]}`);

  // ── Cost Tracker ──
  console.log("\n[Cost Tracking]");
  const costTracker = new CostTracker();
  costTracker.setBudget("tenant_a", 100); // $100/month
  costTracker.onBudgetAlert((tenantId, spent, budget) =>
    console.log(`  🚨 Budget alert: ${tenantId} spent $${spent.toFixed(4)} of $${budget} (${((spent/budget)*100).toFixed(0)}%)`),
  );

  const models = ["gpt-4o", "gpt-4o-mini", "claude-3-5-sonnet"];
  for (let i = 0; i < 15; i++) {
    const model = models[i % models.length]!;
    const cost  = costTracker.record("tenant_a", model, 1000, 500);
    if (i < 3) console.log(`    Recorded: ${model} $${cost.toFixed(6)}`);
  }

  console.log(`  Tenant A total: $${costTracker.tenantCost("tenant_a").toFixed(4)}`);
  console.log("  Top models:", costTracker.topModels().map(m => `${m.model}($${m.totalCost.toFixed(4)})`).join(", "));

  // ── Health Check ──
  console.log("\n[Health Check]");
  const health = new HealthChecker();
  health.register("database",    async () => ({ name: "database",   status: "healthy" }));
  health.register("vector-db",   async () => ({ name: "vector-db",  status: "healthy" }));
  health.register("llm-provider",async () => ({ name: "llm-provider", status: "degraded", error: "P95 latency: 3200ms" }));
  health.register("cache",       async () => ({ name: "cache",      status: "healthy" }));

  const report = await health.check();
  console.log(`  Overall: ${report.status}`);
  report.components.forEach(c => console.log(`    ${c.name.padEnd(15)} ${c.status}${c.error ? ` — ${c.error}` : ""}`));

  // ── Feature Flags ──
  console.log("\n[Feature Flags]");
  const flags = new FeatureFlagService();
  flags.define({ name: "new-rag-pipeline",    enabled: true,  rolloutPct: 50 });
  flags.define({ name: "streaming-responses", enabled: true,  allowlist: ["tenant_a", "tenant_b"] });
  flags.define({ name: "experimental-agents", enabled: false });

  const tenants = ["tenant_a", "tenant_b", "tenant_c", "tenant_d"];
  tenants.forEach(tenantId => {
    const rag = flags.isEnabled("new-rag-pipeline",    { tenantId });
    const str = flags.isEnabled("streaming-responses", { tenantId });
    const exp = flags.isEnabled("experimental-agents", { tenantId });
    console.log(`  ${tenantId}: rag=${rag} streaming=${str} experimental=${exp}`);
  });

  // ── Graceful Shutdown ──
  console.log("\n[Graceful Shutdown]");
  const shutdown = new GracefulShutdown();
  shutdown.register("http-server",  async () => { await new Promise(r => setTimeout(r, 10)); });
  shutdown.register("db-pool",      async () => { await new Promise(r => setTimeout(r, 5));  });
  shutdown.register("llm-clients",  async () => { await new Promise(r => setTimeout(r, 5));  });
  shutdown.register("metrics-flush",async () => { await new Promise(r => setTimeout(r, 10)); });

  await shutdown.shutdown("SIGTERM");

  console.log("\n══════════════════════════════════════");
  console.log(" 🎓 Khóa học hoàn thành!");
  console.log(" Bạn đã học 20 bài về TypeScript:");
  console.log("   • Offline-First & Sync (Bài 1-5)");
  console.log("   • Distributed Systems (Bài 6-10)");
  console.log("   • Gateway & Protocol (Bài 11-14)");
  console.log("   • AI Engineering (Bài 15-18)");
  console.log("   • Production (Bài 19-20)");
  console.log("══════════════════════════════════════\n");
}

main().catch(console.error);

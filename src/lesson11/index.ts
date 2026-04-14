/**
 * Bài 11: Fault Tolerance Patterns
 * ==================================
 * Chạy: npm run lesson11
 *
 * Nội dung:
 *  - Circuit Breaker (state machine: CLOSED → OPEN → HALF_OPEN)
 *  - Retry with exponential backoff + jitter
 *  - Bulkhead (semaphore-based concurrency limiter)
 *  - Timeout wrapper
 *  - Hedged requests
 */

import { EventEmitter } from "eventemitter3";

// ─────────────────────────────────────────────────────────────────────────────
// 1. CIRCUIT BREAKER
// ─────────────────────────────────────────────────────────────────────────────

type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

interface CircuitBreakerConfig {
  failureThreshold:  number;  // failures before opening
  successThreshold:  number;  // successes in HALF_OPEN before closing
  openDurationMs:    number;  // how long to stay OPEN
  timeoutMs:         number;  // request timeout
}

interface CircuitBreakerEvents {
  stateChange: [from: CircuitState, to: CircuitState];
  failure: [error: Error, state: CircuitState];
  success: [latencyMs: number, state: CircuitState];
}

class CircuitBreaker extends EventEmitter<CircuitBreakerEvents> {
  private state:          CircuitState = "CLOSED";
  private failureCount    = 0;
  private successCount    = 0;
  private lastOpenedAt    = 0;

  constructor(
    readonly name: string,
    private config: CircuitBreakerConfig,
  ) { super(); }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "OPEN") {
      const elapsed = Date.now() - this.lastOpenedAt;
      if (elapsed < this.config.openDurationMs) {
        throw new Error(`Circuit ${this.name} is OPEN (${Math.round((this.config.openDurationMs - elapsed) / 1000)}s remaining)`);
      }
      this.transition("HALF_OPEN");
    }

    const start = Date.now();
    try {
      const result = await Promise.race([
        fn(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Timeout after ${this.config.timeoutMs}ms`)), this.config.timeoutMs),
        ),
      ]);

      this.onSuccess(Date.now() - start);
      return result as T;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.onFailure(error);
      throw error;
    }
  }

  private onSuccess(latencyMs: number): void {
    this.failureCount = 0;
    this.emit("success", latencyMs, this.state);
    if (this.state === "HALF_OPEN") {
      this.successCount++;
      if (this.successCount >= this.config.successThreshold) {
        this.successCount = 0;
        this.transition("CLOSED");
      }
    }
  }

  private onFailure(error: Error): void {
    this.emit("failure", error, this.state);
    this.failureCount++;
    if (this.state === "HALF_OPEN" || this.failureCount >= this.config.failureThreshold) {
      this.transition("OPEN");
    }
  }

  private transition(next: CircuitState): void {
    const prev = this.state;
    this.state = next;
    if (next === "OPEN") this.lastOpenedAt = Date.now();
    this.emit("stateChange", prev, next);
    console.log(`  [Circuit:${this.name}] ${prev} → ${next}`);
  }

  get currentState(): CircuitState { return this.state; }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. RETRY WITH BACKOFF
// ─────────────────────────────────────────────────────────────────────────────

interface RetryConfig {
  maxAttempts:  number;
  baseDelayMs:  number;
  maxDelayMs:   number;
  multiplier:   number;
  jitterFactor: number;
  shouldRetry?: (error: Error) => boolean;
}

async function withRetry<T>(
  fn: () => Promise<T>,
  config: RetryConfig,
): Promise<T> {
  let attempt = 0;

  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      const error = err instanceof Error ? err : new Error(String(err));
      const isRetryable = config.shouldRetry ? config.shouldRetry(error) : true;

      if (attempt >= config.maxAttempts || !isRetryable) throw error;

      const exponential = config.baseDelayMs * config.multiplier ** (attempt - 1);
      const capped      = Math.min(exponential, config.maxDelayMs);
      const jitter      = capped * config.jitterFactor * Math.random();
      const delay       = Math.round(capped + jitter);

      console.log(`  [Retry] Attempt ${attempt}/${config.maxAttempts} failed: ${error.message} — retry in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. BULKHEAD (concurrency limiter)
// ─────────────────────────────────────────────────────────────────────────────

class Semaphore {
  private current = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<() => void> {
    if (this.current < this.max) {
      this.current++;
      return this.release.bind(this);
    }
    return new Promise(resolve => {
      this.queue.push(() => {
        this.current++;
        resolve(this.release.bind(this));
      });
    });
  }

  private release(): void {
    this.current--;
    const next = this.queue.shift();
    if (next) next();
  }

  get active(): number  { return this.current; }
  get waiting(): number { return this.queue.length; }
}

class Bulkhead {
  private semaphore: Semaphore;
  private rejected = 0;

  constructor(maxConcurrent: number, private maxQueue = Infinity) {
    this.semaphore = new Semaphore(maxConcurrent);
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.semaphore.waiting >= this.maxQueue) {
      this.rejected++;
      throw new Error(`Bulkhead queue full (${this.semaphore.waiting} waiting, max=${this.maxQueue})`);
    }
    const release = await this.semaphore.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  get stats() {
    return { active: this.semaphore.active, waiting: this.semaphore.waiting, rejected: this.rejected };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. TIMEOUT WRAPPER
// ─────────────────────────────────────────────────────────────────────────────

async function withTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Operation timed out after ${timeoutMs}ms`)), timeoutMs),
    ),
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. HEDGED REQUESTS
// ─────────────────────────────────────────────────────────────────────────────

async function hedgedRequest<T>(
  fns: Array<() => Promise<T>>,
  hedgeAfterMs: number,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const errors: Error[] = [];

    const tryOne = (fn: () => Promise<T>, index: number) => {
      fn().then(
        result => { if (!settled) { settled = true; resolve(result); } },
        err    => {
          errors.push(err instanceof Error ? err : new Error(String(err)));
          if (errors.length === fns.length && !settled) {
            reject(new AggregateError(errors, "All hedged requests failed"));
          }
        },
      );
    };

    // Start first request immediately
    tryOne(fns[0]!, 0);

    // Launch subsequent requests after hedge delay
    for (let i = 1; i < fns.length; i++) {
      const idx = i;
      setTimeout(() => {
        if (!settled) tryOne(fns[idx]!, idx);
      }, hedgeAfterMs * idx);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// DEMO / RUN
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n══════════════════════════════════════");
  console.log(" Bài 11: Fault Tolerance Patterns");
  console.log("══════════════════════════════════════\n");

  // ── Circuit Breaker ──
  console.log("[Circuit Breaker]");
  const cb = new CircuitBreaker("ai-provider", { failureThreshold: 3, successThreshold: 2, openDurationMs: 500, timeoutMs: 200 });

  let callCount = 0;
  const unstableService = async () => {
    callCount++;
    if (callCount <= 4) throw new Error("Service unavailable");
    return `Success on call ${callCount}`;
  };

  for (let i = 0; i < 7; i++) {
    try {
      const result = await cb.execute(unstableService);
      console.log(`  Call ${i + 1}: ${result}`);
    } catch (err) {
      console.log(`  Call ${i + 1}: ❌ ${(err as Error).message}`);
    }
    if (cb.currentState === "OPEN" && i === 4) {
      // Wait for circuit to allow HALF_OPEN
      await new Promise(r => setTimeout(r, 600));
    }
  }
  console.log(`  Final state: ${cb.currentState}`);

  // ── Retry ──
  console.log("\n[Retry with Backoff]");
  let tries = 0;
  const config: RetryConfig = { maxAttempts: 4, baseDelayMs: 20, maxDelayMs: 200, multiplier: 2, jitterFactor: 0.1 };

  try {
    await withRetry(async () => {
      tries++;
      if (tries < 3) throw new Error("Transient error");
      return "OK";
    }, config);
    console.log(`  ✅ Succeeded after ${tries} attempt(s)`);
  } catch (err) {
    console.log(`  ❌ Exhausted: ${(err as Error).message}`);
  }

  // Non-retryable error
  tries = 0;
  try {
    await withRetry(async () => {
      tries++;
      const err = new Error("400 Bad Request");
      (err as Error & { status: number }).status = 400;
      throw err;
    }, { ...config, shouldRetry: e => !e.message.includes("400") });
  } catch (err) {
    console.log(`  ✅ Non-retryable stopped after ${tries} try: ${(err as Error).message}`);
  }

  // ── Bulkhead ──
  console.log("\n[Bulkhead]");
  const bulkhead = new Bulkhead(2, 3);
  const delays = [50, 60, 70, 80, 90, 100, 110];
  const results = await Promise.allSettled(
    delays.map((d, i) =>
      bulkhead.execute(() => new Promise(r => setTimeout(() => r(`task_${i}`), d))),
    ),
  );
  const fulfilled = results.filter(r => r.status === "fulfilled").length;
  const rejected  = results.filter(r => r.status === "rejected").length;
  console.log(`  Fulfilled: ${fulfilled}, Rejected: ${rejected}`);
  console.log(`  Bulkhead stats:`, bulkhead.stats);

  // ── Timeout ──
  console.log("\n[Timeout]");
  try {
    await withTimeout(() => new Promise(r => setTimeout(r, 1000)), 50);
  } catch (err) {
    console.log(`  ✅ Caught: ${(err as Error).message}`);
  }

  // ── Hedged Requests ──
  console.log("\n[Hedged Requests]");
  const t0 = Date.now();
  const result = await hedgedRequest([
    () => new Promise(r => setTimeout(() => r("replica-1"), 300)),
    () => new Promise(r => setTimeout(() => r("replica-2"), 50)),   // fastest
    () => new Promise(r => setTimeout(() => r("replica-3"), 200)),
  ], 80);
  console.log(`  Winner: ${result} in ${Date.now() - t0}ms (expect ≈130ms)`);

  console.log("\n✅ Bài 11 hoàn thành!\n");
}

main().catch(console.error);

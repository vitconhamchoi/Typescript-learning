# Bài 11: Fault Tolerance Patterns với TypeScript

## Mục tiêu bài học

- Implement Circuit Breaker pattern cho LLM providers
- Retry với Exponential Backoff và Jitter
- Bulkhead: isolate failures để ngăn cascade failures
- Timeout và Deadline propagation
- Hedged requests cho low-latency AI calls

---

## 11.1 Circuit Breaker Pattern

Circuit Breaker ngăn chặn cascade failures: khi service lỗi nhiều lần, "mở" circuit để fail fast thay vì chờ timeout.

```typescript
type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

interface CircuitBreakerConfig {
  failureThreshold: number;      // Number of failures to open circuit
  successThreshold: number;      // Successes needed to close from HALF_OPEN
  timeout: number;               // Ms before trying HALF_OPEN from OPEN
  volumeThreshold: number;       // Min requests before calculating failure rate
  failureRateThreshold: number;  // Percentage (0-100) to open circuit
  slowCallThreshold: number;     // Ms to consider a call "slow"
  slowCallRateThreshold: number; // Percentage of slow calls to open circuit
}

interface CircuitBreakerMetrics {
  totalCalls: number;
  successCalls: number;
  failureCalls: number;
  slowCalls: number;
  consecutiveSuccesses: number;
  consecutiveFailures: number;
  lastFailureTime: Date | null;
  state: CircuitState;
}

class CircuitBreaker<T> {
  private state: CircuitState = "CLOSED";
  private metrics: CircuitBreakerMetrics = {
    totalCalls: 0,
    successCalls: 0,
    failureCalls: 0,
    slowCalls: 0,
    consecutiveSuccesses: 0,
    consecutiveFailures: 0,
    lastFailureTime: null,
    state: "CLOSED",
  };
  private halfOpenPermits = 0;
  private maxHalfOpenPermits = 3;

  constructor(
    private name: string,
    private config: CircuitBreakerConfig,
    private onStateChange?: (from: CircuitState, to: CircuitState) => void
  ) {}

  async execute(fn: () => Promise<T>): Promise<T> {
    if (this.state === "OPEN") {
      if (this.shouldAttemptReset()) {
        this.transitionTo("HALF_OPEN");
      } else {
        throw new CircuitOpenError(this.name, this.getRetryAfter());
      }
    }

    if (this.state === "HALF_OPEN") {
      if (this.halfOpenPermits >= this.maxHalfOpenPermits) {
        throw new CircuitOpenError(this.name, 0);
      }
      this.halfOpenPermits++;
    }

    const startTime = Date.now();
    try {
      const result = await fn();
      const duration = Date.now() - startTime;
      this.recordSuccess(duration);
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }

  private recordSuccess(durationMs: number): void {
    this.metrics.totalCalls++;
    this.metrics.successCalls++;
    this.metrics.consecutiveSuccesses++;
    this.metrics.consecutiveFailures = 0;

    if (durationMs > this.config.slowCallThreshold) {
      this.metrics.slowCalls++;
    }

    if (this.state === "HALF_OPEN") {
      this.halfOpenPermits = Math.max(0, this.halfOpenPermits - 1);
      if (this.metrics.consecutiveSuccesses >= this.config.successThreshold) {
        this.transitionTo("CLOSED");
      }
    }
  }

  private recordFailure(): void {
    this.metrics.totalCalls++;
    this.metrics.failureCalls++;
    this.metrics.consecutiveFailures++;
    this.metrics.consecutiveSuccesses = 0;
    this.metrics.lastFailureTime = new Date();

    if (this.state === "HALF_OPEN") {
      this.transitionTo("OPEN");
      return;
    }

    if (this.state === "CLOSED" && this.shouldOpen()) {
      this.transitionTo("OPEN");
    }
  }

  private shouldOpen(): boolean {
    if (this.metrics.totalCalls < this.config.volumeThreshold) return false;
    
    const failureRate = (this.metrics.failureCalls / this.metrics.totalCalls) * 100;
    if (failureRate >= this.config.failureRateThreshold) return true;
    
    const slowRate = (this.metrics.slowCalls / this.metrics.totalCalls) * 100;
    if (slowRate >= this.config.slowCallRateThreshold) return true;
    
    return this.metrics.consecutiveFailures >= this.config.failureThreshold;
  }

  private shouldAttemptReset(): boolean {
    if (!this.metrics.lastFailureTime) return true;
    return Date.now() - this.metrics.lastFailureTime.getTime() >= this.config.timeout;
  }

  private getRetryAfter(): number {
    if (!this.metrics.lastFailureTime) return 0;
    return Math.max(0, this.config.timeout - (Date.now() - this.metrics.lastFailureTime.getTime()));
  }

  private transitionTo(newState: CircuitState): void {
    const oldState = this.state;
    this.state = newState;
    this.metrics.state = newState;

    if (newState === "CLOSED") {
      this.resetMetrics();
    }
    if (newState === "HALF_OPEN") {
      this.halfOpenPermits = 0;
    }

    console.log(`[CircuitBreaker:${this.name}] ${oldState} → ${newState}`);
    this.onStateChange?.(oldState, newState);
  }

  private resetMetrics(): void {
    this.metrics.totalCalls = 0;
    this.metrics.successCalls = 0;
    this.metrics.failureCalls = 0;
    this.metrics.slowCalls = 0;
    this.metrics.consecutiveSuccesses = 0;
    this.metrics.consecutiveFailures = 0;
  }

  getMetrics(): Readonly<CircuitBreakerMetrics> {
    return { ...this.metrics };
  }

  getState(): CircuitState {
    return this.state;
  }

  // Force state (for testing)
  forceState(state: CircuitState): void {
    this.transitionTo(state);
  }
}

class CircuitOpenError extends Error {
  constructor(
    public circuitName: string,
    public retryAfterMs: number
  ) {
    super(`Circuit '${circuitName}' is OPEN. Retry after ${retryAfterMs}ms`);
    this.name = "CircuitOpenError";
  }
}
```

---

## 11.2 Retry với Exponential Backoff & Jitter

```typescript
interface RetryConfig {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  jitter: boolean;                     // Add randomness to avoid thundering herd
  retryableErrors?: Array<string | RegExp>;  // Error messages/codes to retry
  nonRetryableErrors?: Array<string | RegExp>;
}

interface RetryResult<T> {
  value: T;
  attempts: number;
  totalDurationMs: number;
}

class RetryStrategy {
  static async execute<T>(
    fn: () => Promise<T>,
    config: RetryConfig,
    onRetry?: (attempt: number, error: Error, delayMs: number) => void
  ): Promise<RetryResult<T>> {
    const startTime = Date.now();
    let lastError: Error;

    for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
      try {
        const value = await fn();
        return {
          value,
          attempts: attempt,
          totalDurationMs: Date.now() - startTime,
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Check if error is retryable
        if (!this.isRetryable(lastError, config)) {
          throw lastError;
        }

        if (attempt === config.maxAttempts) break;

        const delay = this.calculateDelay(attempt, config);
        onRetry?.(attempt, lastError, delay);
        
        await sleep(delay);
      }
    }

    throw lastError!;
  }

  private static calculateDelay(attempt: number, config: RetryConfig): number {
    let delay = config.initialDelayMs * Math.pow(config.backoffMultiplier, attempt - 1);
    delay = Math.min(delay, config.maxDelayMs);

    if (config.jitter) {
      // Full jitter: randomize between 0 and calculated delay
      delay = Math.random() * delay;
    }

    return Math.floor(delay);
  }

  private static isRetryable(error: Error, config: RetryConfig): boolean {
    // If non-retryable list is defined, check it first
    if (config.nonRetryableErrors?.length) {
      for (const pattern of config.nonRetryableErrors) {
        if (typeof pattern === "string" && error.message.includes(pattern)) return false;
        if (pattern instanceof RegExp && pattern.test(error.message)) return false;
      }
    }

    // If retryable list is defined, check it
    if (config.retryableErrors?.length) {
      for (const pattern of config.retryableErrors) {
        if (typeof pattern === "string" && error.message.includes(pattern)) return true;
        if (pattern instanceof RegExp && pattern.test(error.message)) return true;
      }
      return false; // Not in retryable list
    }

    // Default: retry all errors
    return true;
  }
}

// Usage for AI API calls
const AI_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  backoffMultiplier: 2,
  jitter: true,
  retryableErrors: [
    "rate_limit_exceeded",
    "service_unavailable",
    "gateway_timeout",
    /5\d\d/, // 5xx status codes
  ],
  nonRetryableErrors: [
    "invalid_api_key",
    "context_length_exceeded",
    "content_policy_violation",
  ],
};

async function callLLMWithRetry(
  fn: () => Promise<unknown>
): Promise<unknown> {
  const result = await RetryStrategy.execute(fn, AI_RETRY_CONFIG, (attempt, error, delay) => {
    console.warn(`[Retry] Attempt ${attempt} failed: ${error.message}. Retrying in ${delay}ms`);
  });
  return result.value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

---

## 11.3 Bulkhead Pattern — Isolate Failures

Bulkhead giới hạn concurrent requests tới từng dependency, ngăn một service chậm làm chậm toàn bộ system:

```typescript
interface BulkheadConfig {
  maxConcurrent: number;         // Max concurrent executions
  maxQueueSize: number;          // Max items waiting in queue
  queueTimeoutMs: number;        // How long to wait in queue before rejection
}

class Bulkhead {
  private currentConcurrent = 0;
  private queue: Array<{
    resolve: (slot: () => void) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
    enqueuedAt: number;
  }> = [];

  constructor(
    private name: string,
    private config: BulkheadConfig
  ) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const releaseSlot = await this.acquireSlot();
    try {
      return await fn();
    } finally {
      releaseSlot();
      this.processQueue();
    }
  }

  private acquireSlot(): Promise<() => void> {
    if (this.currentConcurrent < this.config.maxConcurrent) {
      this.currentConcurrent++;
      return Promise.resolve(() => {
        this.currentConcurrent--;
      });
    }

    if (this.queue.length >= this.config.maxQueueSize) {
      return Promise.reject(
        new BulkheadFullError(this.name, this.currentConcurrent, this.queue.length)
      );
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const idx = this.queue.findIndex((q) => q.resolve === resolve);
        if (idx >= 0) {
          this.queue.splice(idx, 1);
          reject(new BulkheadQueueTimeoutError(this.name, this.config.queueTimeoutMs));
        }
      }, this.config.queueTimeoutMs);

      this.queue.push({ resolve, reject, timeout, enqueuedAt: Date.now() });
    });
  }

  private processQueue(): void {
    while (
      this.queue.length > 0 &&
      this.currentConcurrent < this.config.maxConcurrent
    ) {
      const next = this.queue.shift()!;
      clearTimeout(next.timeout);
      this.currentConcurrent++;
      next.resolve(() => {
        this.currentConcurrent--;
      });
    }
  }

  getStats() {
    return {
      name: this.name,
      concurrent: this.currentConcurrent,
      queued: this.queue.length,
      available: this.config.maxConcurrent - this.currentConcurrent,
    };
  }
}

class BulkheadFullError extends Error {
  constructor(name: string, concurrent: number, queued: number) {
    super(`Bulkhead '${name}' full: ${concurrent} concurrent, ${queued} queued`);
    this.name = "BulkheadFullError";
  }
}

class BulkheadQueueTimeoutError extends Error {
  constructor(name: string, timeoutMs: number) {
    super(`Bulkhead '${name}' queue timeout after ${timeoutMs}ms`);
    this.name = "BulkheadQueueTimeoutError";
  }
}

// Separate bulkheads for different AI services
const bulkheads = {
  openai: new Bulkhead("openai", { maxConcurrent: 20, maxQueueSize: 50, queueTimeoutMs: 10000 }),
  anthropic: new Bulkhead("anthropic", { maxConcurrent: 10, maxQueueSize: 30, queueTimeoutMs: 10000 }),
  embeddings: new Bulkhead("embeddings", { maxConcurrent: 50, maxQueueSize: 200, queueTimeoutMs: 5000 }),
  imageGen: new Bulkhead("imageGen", { maxConcurrent: 5, maxQueueSize: 20, queueTimeoutMs: 30000 }),
};
```

---

## 11.4 Timeout & Deadline Propagation

```typescript
// AbortController-based timeout
async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  timeoutError?: Error
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(timeoutError ?? new Error(`Operation timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  try {
    return await fn(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) {
      throw controller.signal.reason ?? new Error("Aborted");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    if (!controller.signal.aborted) {
      controller.abort(); // Clean up
    }
  }
}

// Deadline context for distributed requests
interface DeadlineContext {
  signal: AbortSignal;
  remainingMs: () => number;
  deadline: Date;
  isExpired: () => boolean;
}

function createDeadlineContext(timeoutMs: number): DeadlineContext {
  const controller = new AbortController();
  const deadline = new Date(Date.now() + timeoutMs);
  
  const timeout = setTimeout(() => {
    controller.abort(new Error(`Deadline exceeded: ${deadline.toISOString()}`));
  }, timeoutMs);

  // Clean up timeout if signal is manually aborted
  controller.signal.addEventListener("abort", () => clearTimeout(timeout), { once: true });

  return {
    signal: controller.signal,
    remainingMs: () => Math.max(0, deadline.getTime() - Date.now()),
    deadline,
    isExpired: () => Date.now() > deadline.getTime(),
  };
}

// Usage: cascade timeout through chain
async function handleAIRequest(
  userMessage: string,
  totalTimeoutMs: number = 30000
): Promise<string> {
  const ctx = createDeadlineContext(totalTimeoutMs);

  if (ctx.isExpired()) throw new Error("Already expired before starting");

  // Step 1: Get user context (with sub-deadline)
  const contextTimeoutMs = Math.min(5000, ctx.remainingMs());
  const userContext = await withTimeout(
    async (signal) => fetchUserContext(signal),
    contextTimeoutMs
  );

  // Step 2: Call LLM with remaining time
  const llmTimeoutMs = Math.min(25000, ctx.remainingMs());
  const response = await withTimeout(
    async (signal) => callLLM(userMessage, userContext, signal),
    llmTimeoutMs
  );

  return response;
}

async function fetchUserContext(signal: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetch("/api/user/context", { signal });
  return response.json() as Promise<Record<string, unknown>>;
}

async function callLLM(
  message: string,
  context: Record<string, unknown>,
  signal: AbortSignal
): Promise<string> {
  const response = await fetch("/api/llm/complete", {
    method: "POST",
    signal,
    body: JSON.stringify({ message, context }),
    headers: { "Content-Type": "application/json" },
  });
  const data = await response.json() as { content: string };
  return data.content;
}
```

---

## 11.5 Hedged Requests — Reduce P99 Latency

Hedged requests: gửi request thứ hai sau delay ngắn nếu request đầu chưa trả về. Dùng kết quả nào về trước.

```typescript
interface HedgeConfig {
  hedgeDelayMs: number;          // Delay before sending hedge request
  maxHedgeAttempts: number;      // Max number of hedge attempts
  cancelOthersOnSuccess: boolean; // Cancel remaining requests when one succeeds
}

class HedgedExecutor {
  constructor(private config: HedgeConfig) {}

  async execute<T>(
    fn: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const controllers: AbortController[] = [];
    const promises: Promise<{ value: T; index: number }>[] = [];

    const createAttempt = (index: number): Promise<{ value: T; index: number }> => {
      const controller = new AbortController();
      controllers.push(controller);
      
      return fn(controller.signal).then((value) => ({ value, index }));
    };

    // Start first attempt
    promises.push(createAttempt(0));

    // Schedule hedge attempts
    const hedgeTimeouts: ReturnType<typeof setTimeout>[] = [];
    for (let i = 1; i < this.config.maxHedgeAttempts; i++) {
      const hedgeTimeout = setTimeout(() => {
        if (promises.length <= i) {
          promises.push(createAttempt(i));
        }
      }, this.config.hedgeDelayMs * i);
      hedgeTimeouts.push(hedgeTimeout);
    }

    try {
      // Use Promise.any — resolves with first successful result
      const result = await Promise.any(promises);

      if (this.config.cancelOthersOnSuccess) {
        // Cancel all other in-flight requests
        controllers.forEach((ctrl, idx) => {
          if (idx !== result.index) {
            ctrl.abort(new Error("Hedged request cancelled: another succeeded"));
          }
        });
      }

      return result.value;
    } finally {
      hedgeTimeouts.forEach(clearTimeout);
    }
  }
}

// Composite Resilience Pattern: Circuit Breaker + Retry + Bulkhead + Timeout
class ResilientAIClient {
  private circuitBreaker: CircuitBreaker<string>;
  private bulkhead: Bulkhead;
  private hedgedExecutor: HedgedExecutor;

  constructor(
    private baseClient: { complete(prompt: string, signal: AbortSignal): Promise<string> }
  ) {
    this.circuitBreaker = new CircuitBreaker("ai-client", {
      failureThreshold: 5,
      successThreshold: 2,
      timeout: 30000,
      volumeThreshold: 10,
      failureRateThreshold: 50,
      slowCallThreshold: 5000,
      slowCallRateThreshold: 70,
    }, (from, to) => {
      console.log(`Circuit Breaker: ${from} → ${to}`);
    });

    this.bulkhead = new Bulkhead("ai-client", {
      maxConcurrent: 20,
      maxQueueSize: 50,
      queueTimeoutMs: 10000,
    });

    this.hedgedExecutor = new HedgedExecutor({
      hedgeDelayMs: 2000,       // Send hedge after 2s
      maxHedgeAttempts: 2,       // Max 2 parallel attempts
      cancelOthersOnSuccess: true,
    });
  }

  async complete(prompt: string, timeoutMs: number = 30000): Promise<string> {
    // Layer 1: Bulkhead (limit concurrency)
    return this.bulkhead.execute(async () => {
      // Layer 2: Circuit Breaker (fast fail when service is down)
      return this.circuitBreaker.execute(async () => {
        // Layer 3: Retry (handle transient failures)
        const result = await RetryStrategy.execute(
          async () => {
            // Layer 4: Hedged requests (reduce P99 latency)
            return this.hedgedExecutor.execute(async (signal) => {
              // Layer 5: Timeout (guarantee max wait time)
              return withTimeout(
                (timeoutSignal) => {
                  // Combine signals
                  const combined = combineSignals(signal, timeoutSignal);
                  return this.baseClient.complete(prompt, combined);
                },
                timeoutMs
              );
            });
          },
          AI_RETRY_CONFIG,
          (attempt, error, delay) => {
            console.warn(`Retry ${attempt}: ${error.message}, waiting ${delay}ms`);
          }
        );
        return result.value;
      });
    });
  }

  getHealthStatus() {
    return {
      circuitBreaker: this.circuitBreaker.getMetrics(),
      bulkhead: this.bulkhead.getStats(),
    };
  }
}

function combineSignals(...signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  
  return controller.signal;
}
```

---

## Tóm tắt Bài 11

| Pattern | Giải quyết | TypeScript Implementation |
|---------|-----------|--------------------------|
| Circuit Breaker | Cascade failures | State machine + metrics |
| Retry + Backoff | Transient failures | Exponential delay + jitter |
| Bulkhead | Resource exhaustion | Semaphore + queue |
| Timeout + Deadline | Slow services | AbortController |
| Hedged Requests | High P99 latency | Promise.any + parallel |

## Bài tập thực hành

1. Implement **Adaptive Retry**: tự động điều chỉnh retry delay dựa trên `Retry-After` header từ server.
2. Xây dựng **Health Check Dashboard**: monitor trạng thái tất cả circuit breakers, hiển thị metrics real-time.
3. Implement **Fallback Provider**: khi circuit breaker OpenAI mở, tự động route sang Anthropic Claude.

---

*Tiếp theo: [Bài 12 — Cross-Platform Mobile với React Native](12-crossplatform-mobile-react-native.md)*

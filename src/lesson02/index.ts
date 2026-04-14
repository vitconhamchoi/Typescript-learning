/**
 * Bài 2: Offline-First Architecture Core Concepts
 * ===================================================
 * Chạy: npm run lesson02
 *
 * Nội dung:
 *  - NetworkStatus detection & typed events
 *  - Storage strategy (cache-first, network-first, stale-while-revalidate)
 *  - Operation queue with persistence
 *  - Sync state machine (FSM)
 */

import { EventEmitter } from "eventemitter3";

// ─────────────────────────────────────────────────────────────────────────────
// 1. NETWORK STATUS MONITOR
// ─────────────────────────────────────────────────────────────────────────────

type NetworkStatus = "online" | "offline" | "slow";

interface NetworkEvents {
  statusChange: [status: NetworkStatus, prevStatus: NetworkStatus];
  latencyUpdate: [latencyMs: number];
}

class NetworkMonitor extends EventEmitter<NetworkEvents> {
  private _status: NetworkStatus = "online";
  private _latency = 0;

  get status(): NetworkStatus { return this._status; }
  get latency(): number       { return this._latency; }
  get isOnline(): boolean     { return this._status !== "offline"; }

  // Simulate: in a real browser you'd listen to window.navigator.onLine
  simulate(status: NetworkStatus, latencyMs = 0): void {
    const prev = this._status;
    this._status  = status;
    this._latency = latencyMs;
    if (prev !== status) {
      this.emit("statusChange", status, prev);
    }
    this.emit("latencyUpdate", latencyMs);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. STORAGE STRATEGIES
// ─────────────────────────────────────────────────────────────────────────────

type CacheStrategy =
  | "cache-first"            // serve from cache, refresh in background
  | "network-first"          // try network, fallback to cache
  | "stale-while-revalidate" // serve cache immediately, refresh async
  | "network-only"           // never use cache
  | "cache-only";            // never hit network

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number; // ms
  etag?: string;
}

class InMemoryCache<T> {
  private store = new Map<string, CacheEntry<T>>();

  set(key: string, data: T, ttlMs = 5 * 60_000, etag?: string): void {
    const entry: CacheEntry<T> = { data, timestamp: Date.now(), ttl: ttlMs };
    if (etag !== undefined) entry.etag = etag;
    this.store.set(key, entry);
  }

  get(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > entry.ttl) {
      this.store.delete(key);
      return null;
    }
    return entry.data;
  }

  isStale(key: string): boolean {
    const entry = this.store.get(key);
    if (!entry) return true;
    // Consider stale after half TTL for SWR
    return Date.now() - entry.timestamp > entry.ttl / 2;
  }

  has(key: string): boolean { return this.store.has(key); }
  delete(key: string): void { this.store.delete(key); }
  clear(): void             { this.store.clear(); }
}

type FetchFn<T> = (key: string) => Promise<T>;

async function fetchWithStrategy<T>(
  key: string,
  fetch: FetchFn<T>,
  cache: InMemoryCache<T>,
  network: NetworkMonitor,
  strategy: CacheStrategy,
): Promise<T> {
  switch (strategy) {
    case "cache-first": {
      const cached = cache.get(key);
      if (cached !== null) return cached;
      const fresh = await fetch(key);
      cache.set(key, fresh);
      return fresh;
    }

    case "network-first": {
      if (network.isOnline) {
        try {
          const fresh = await fetch(key);
          cache.set(key, fresh);
          return fresh;
        } catch {
          // fall through to cache
        }
      }
      const cached = cache.get(key);
      if (cached !== null) return cached;
      throw new Error(`[network-first] Offline and no cache for key: ${key}`);
    }

    case "stale-while-revalidate": {
      const cached = cache.get(key);
      if (cached !== null) {
        if (cache.isStale(key) && network.isOnline) {
          // Refresh in background — don't await
          fetch(key).then(fresh => cache.set(key, fresh)).catch(() => {/* swallow */});
        }
        return cached;
      }
      const fresh = await fetch(key);
      cache.set(key, fresh);
      return fresh;
    }

    case "network-only": {
      const fresh = await fetch(key);
      return fresh;
    }

    case "cache-only": {
      const cached = cache.get(key);
      if (cached !== null) return cached;
      throw new Error(`[cache-only] No cache entry for key: ${key}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. OFFLINE OPERATION QUEUE
// ─────────────────────────────────────────────────────────────────────────────

interface QueuedOperation {
  id: string;
  type: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
  createdAt: number;
  nextRetryAt: number;
}

class OfflineOperationQueue {
  private queue: QueuedOperation[] = [];

  enqueue(type: string, payload: unknown, maxAttempts = 5): string {
    const id = `op_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    this.queue.push({
      id, type, payload,
      attempts: 0, maxAttempts,
      createdAt: Date.now(),
      nextRetryAt: Date.now(),
    });
    console.log(`  [Queue] Enqueued operation ${id} (type=${type})`);
    return id;
  }

  async flush(handler: (op: QueuedOperation) => Promise<void>): Promise<void> {
    const now = Date.now();
    const ready = this.queue.filter(op =>
      op.attempts < op.maxAttempts && op.nextRetryAt <= now,
    );

    for (const op of ready) {
      try {
        await handler(op);
        this.queue = this.queue.filter(q => q.id !== op.id);
        console.log(`  [Queue] ✅ Flushed ${op.id}`);
      } catch (err) {
        op.attempts++;
        // Exponential back-off with jitter
        const backoff = Math.min(1000 * 2 ** op.attempts, 30_000);
        const jitter   = Math.random() * 1000;
        op.nextRetryAt = Date.now() + backoff + jitter;
        console.log(`  [Queue] ❌ Failed ${op.id} attempt ${op.attempts}/${op.maxAttempts} — retry in ${Math.round((backoff + jitter) / 1000)}s`);
        if (op.attempts >= op.maxAttempts) {
          console.log(`  [Queue] 🗑️  Dead-lettered ${op.id}`);
          this.queue = this.queue.filter(q => q.id !== op.id);
        }
      }
    }
  }

  get size(): number       { return this.queue.length; }
  get pending(): readonly QueuedOperation[] { return [...this.queue]; }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. SYNC STATE MACHINE
// ─────────────────────────────────────────────────────────────────────────────

type SyncState = "idle" | "syncing" | "error" | "paused";

type SyncEvent =
  | { type: "START" }
  | { type: "SUCCESS" }
  | { type: "FAILURE"; error: Error }
  | { type: "PAUSE" }
  | { type: "RESUME" };

const SYNC_TRANSITIONS: Record<SyncState, Partial<Record<SyncEvent["type"], SyncState>>> = {
  idle:    { START: "syncing" },
  syncing: { SUCCESS: "idle", FAILURE: "error", PAUSE: "paused" },
  error:   { START: "syncing", PAUSE: "paused" },
  paused:  { RESUME: "idle", START: "syncing" },
};

class SyncStateMachine {
  private _state: SyncState = "idle";

  get state(): SyncState { return this._state; }

  transition(event: SyncEvent): SyncState {
    const nextState = SYNC_TRANSITIONS[this._state]?.[event.type];
    if (!nextState) {
      console.log(`  [FSM] ⚠️  No transition from '${this._state}' on '${event.type}'`);
      return this._state;
    }
    console.log(`  [FSM] ${this._state} ──${event.type}──▶ ${nextState}`);
    this._state = nextState;
    return nextState;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DEMO / RUN
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n══════════════════════════════════════");
  console.log(" Bài 2: Offline-First Architecture");
  console.log("══════════════════════════════════════\n");

  // ── Network Monitor ──
  const network = new NetworkMonitor();
  network.on("statusChange", (status, prev) =>
    console.log(`[Network] ${prev} → ${status}`),
  );
  network.simulate("online");
  network.simulate("offline");
  network.simulate("slow", 800);
  network.simulate("online", 50);

  // ── Storage Strategies ──
  console.log("\n[Storage Strategies]");
  const cache = new InMemoryCache<string>();
  let fetchCount = 0;
  const mockFetch: FetchFn<string> = async (key) => {
    fetchCount++;
    return `data_for_${key}_v${fetchCount}`;
  };

  // Cache-first: populates cache on first call
  const r1 = await fetchWithStrategy("user:1", mockFetch, cache, network, "cache-first");
  const r2 = await fetchWithStrategy("user:1", mockFetch, cache, network, "cache-first");
  console.log(`  cache-first r1=${r1}, r2=${r2} (fetchCount=${fetchCount})`);

  // SWR
  const r3 = await fetchWithStrategy("posts:1", mockFetch, cache, network, "stale-while-revalidate");
  console.log(`  stale-while-revalidate r3=${r3}`);

  // ── Offline Queue ──
  console.log("\n[Offline Operation Queue]");
  const opQueue = new OfflineOperationQueue();
  opQueue.enqueue("CREATE_NOTE", { title: "Meeting", body: "..." });
  opQueue.enqueue("UPDATE_USER", { id: "usr_1", name: "Alice" });
  opQueue.enqueue("DELETE_TAG",  { id: "tag_99" });

  let flushCall = 0;
  await opQueue.flush(async (op) => {
    flushCall++;
    if (flushCall === 2) throw new Error("Simulated network error");
    console.log(`    Processing: ${op.type}`, op.payload);
  });
  console.log(`  Queue size after flush: ${opQueue.size}`);

  // ── Sync FSM ──
  console.log("\n[Sync State Machine]");
  const fsm = new SyncStateMachine();
  fsm.transition({ type: "START" });
  fsm.transition({ type: "PAUSE" });
  fsm.transition({ type: "RESUME" });
  fsm.transition({ type: "START" });
  fsm.transition({ type: "SUCCESS" });
  fsm.transition({ type: "START" });
  fsm.transition({ type: "FAILURE", error: new Error("timeout") });
  console.log(`  Final state: ${fsm.state}`);

  console.log("\n✅ Bài 2 hoàn thành!\n");
}

main().catch(console.error);

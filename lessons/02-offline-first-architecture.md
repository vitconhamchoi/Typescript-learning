# Bài 2: Offline-First Architecture Core Concepts

## Mục tiêu bài học

- Hiểu triết lý "offline-first" và tại sao nó quan trọng cho AI apps
- Nắm vững các storage strategies: Local-first, Cache-first, Network-first
- Thiết kế sync patterns và conflict resolution strategies
- Implement offline-aware TypeScript abstractions cho AI features

---

## 2.1 Triết lý Offline-First

**Offline-first** không có nghĩa là "chỉ hoạt động offline" — mà là **thiết kế cho offline như mặc định**, network như enhancement.

```
Traditional (Network-first):           Offline-First:
App → Network → Response               App → Local Store → Response
  ↓ (failure)                            ↑ (async sync)
Error / Spinner                         Network → Local Store
```

Trong bối cảnh AI:
- **LLM responses** có thể cache và serve locally
- **Embeddings** tính toán một lần, store local
- **User context** sync khi online
- **Prompts và configs** pre-loaded khi có mạng

---

## 2.2 Storage Strategy Architecture

```typescript
// Định nghĩa các storage strategies
type StorageStrategy =
  | "local-only"        // Chỉ đọc local, không sync
  | "cache-first"       // Local trước, background sync
  | "network-first"     // Network trước, fallback local
  | "stale-while-revalidate"  // Trả local ngay, sync background
  | "network-only"      // Chỉ network, không cache
  | "local-first-sync"; // Local write, sync khi online

// Data freshness metadata
interface DataFreshness {
  lastModified: Date;
  lastSynced: Date | null;
  version: number;
  isDirty: boolean;      // Has unsync'd local changes
  conflictVersion?: number;
}

// Generic offline-aware data wrapper
interface OfflineAwareData<T> {
  data: T;
  freshness: DataFreshness;
  source: "local" | "network" | "cache";
  strategy: StorageStrategy;
}

// Abstract storage layer
interface StorageLayer<T> {
  read(key: string): Promise<OfflineAwareData<T> | null>;
  write(key: string, data: T): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
  sync(): Promise<SyncResult>;
}

interface SyncResult {
  synced: number;
  failed: number;
  conflicts: Array<ConflictRecord<unknown>>;
  duration: number;
}

interface ConflictRecord<T> {
  key: string;
  localVersion: T;
  remoteVersion: T;
  localTimestamp: Date;
  remoteTimestamp: Date;
}
```

---

## 2.3 Offline-First Data Manager

```typescript
import type { StorageLayer, OfflineAwareData, StorageStrategy, SyncResult, ConflictRecord } from "./types";

// Network status detector
class NetworkStatusManager {
  private isOnline: boolean = navigator.onLine;
  private listeners = new Set<(online: boolean) => void>();

  constructor() {
    if (typeof window !== "undefined") {
      window.addEventListener("online", () => this.setOnline(true));
      window.addEventListener("offline", () => this.setOnline(false));
    }
  }

  private setOnline(online: boolean): void {
    if (this.isOnline !== online) {
      this.isOnline = online;
      this.listeners.forEach((l) => l(online));
    }
  }

  get online(): boolean {
    return this.isOnline;
  }

  onChange(listener: (online: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

// Sync queue for offline operations
interface QueuedOperation {
  id: string;
  type: "create" | "update" | "delete";
  key: string;
  data: unknown;
  timestamp: Date;
  retryCount: number;
  maxRetries: number;
}

class OfflineSyncQueue {
  private queue: Map<string, QueuedOperation> = new Map();

  enqueue(op: Omit<QueuedOperation, "id" | "timestamp" | "retryCount">): string {
    const id = crypto.randomUUID();
    this.queue.set(id, {
      ...op,
      id,
      timestamp: new Date(),
      retryCount: 0,
    });
    this.persist();
    return id;
  }

  dequeue(id: string): void {
    this.queue.delete(id);
    this.persist();
  }

  getAll(): QueuedOperation[] {
    return Array.from(this.queue.values()).sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime()
    );
  }

  markRetry(id: string): void {
    const op = this.queue.get(id);
    if (op) {
      op.retryCount++;
      if (op.retryCount >= op.maxRetries) {
        this.queue.delete(id);
      }
      this.persist();
    }
  }

  private persist(): void {
    // Persist queue to localStorage for survival across page reloads
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(
        "sync_queue",
        JSON.stringify(Array.from(this.queue.entries()))
      );
    }
  }

  restore(): void {
    if (typeof localStorage !== "undefined") {
      const stored = localStorage.getItem("sync_queue");
      if (stored) {
        try {
          const entries = JSON.parse(stored) as Array<[string, QueuedOperation]>;
          this.queue = new Map(
            entries.map(([k, v]) => [k, { ...v, timestamp: new Date(v.timestamp) }])
          );
        } catch {
          // Corrupt queue, start fresh
          localStorage.removeItem("sync_queue");
        }
      }
    }
  }
}

// Main Offline-First Data Manager
class OfflineFirstDataManager<T extends { id: string; updatedAt: Date }> {
  private networkStatus = new NetworkStatusManager();
  private syncQueue = new OfflineSyncQueue();
  private syncInProgress = false;

  constructor(
    private localStore: StorageLayer<T>,
    private remoteStore: { 
      fetch(key: string): Promise<T | null>;
      save(key: string, data: T): Promise<T>;
      delete(key: string): Promise<void>;
    },
    private conflictResolver: ConflictResolver<T>
  ) {
    this.syncQueue.restore();
    this.networkStatus.onChange((online) => {
      if (online) this.syncPendingOperations();
    });
  }

  async read(key: string, strategy: StorageStrategy = "stale-while-revalidate"): Promise<T | null> {
    switch (strategy) {
      case "local-only":
        return (await this.localStore.read(key))?.data ?? null;

      case "cache-first": {
        const local = await this.localStore.read(key);
        if (local) {
          this.backgroundSync(key);
          return local.data;
        }
        return this.fetchAndCache(key);
      }

      case "network-first": {
        if (this.networkStatus.online) {
          try {
            return await this.fetchAndCache(key);
          } catch {
            return (await this.localStore.read(key))?.data ?? null;
          }
        }
        return (await this.localStore.read(key))?.data ?? null;
      }

      case "stale-while-revalidate": {
        const local = await this.localStore.read(key);
        if (local) {
          // Return stale data immediately, revalidate in background
          if (this.networkStatus.online) {
            this.backgroundSync(key).catch(console.error);
          }
          return local.data;
        }
        return this.networkStatus.online ? this.fetchAndCache(key) : null;
      }

      case "network-only":
        return this.fetchAndCache(key);

      default:
        return (await this.localStore.read(key))?.data ?? null;
    }
  }

  async write(key: string, data: T): Promise<void> {
    // Always write locally first
    await this.localStore.write(key, data);

    if (this.networkStatus.online) {
      try {
        await this.remoteStore.save(key, data);
      } catch {
        // Queue for later sync
        this.syncQueue.enqueue({
          type: "update",
          key,
          data,
          maxRetries: 5,
        });
      }
    } else {
      // Offline: queue for sync
      this.syncQueue.enqueue({
        type: "update",
        key,
        data,
        maxRetries: 5,
      });
    }
  }

  async delete(key: string): Promise<void> {
    await this.localStore.delete(key);

    if (this.networkStatus.online) {
      try {
        await this.remoteStore.delete(key);
      } catch {
        this.syncQueue.enqueue({ type: "delete", key, data: null, maxRetries: 5 });
      }
    } else {
      this.syncQueue.enqueue({ type: "delete", key, data: null, maxRetries: 5 });
    }
  }

  private async fetchAndCache(key: string): Promise<T | null> {
    const remote = await this.remoteStore.fetch(key);
    if (remote) {
      await this.localStore.write(key, remote);
    }
    return remote;
  }

  private backgroundSync(key: string): Promise<void> {
    return this.fetchAndCache(key).then(() => undefined);
  }

  private async syncPendingOperations(): Promise<void> {
    if (this.syncInProgress) return;
    this.syncInProgress = true;

    const operations = this.syncQueue.getAll();
    console.log(`Syncing ${operations.length} pending operations...`);

    for (const op of operations) {
      try {
        if (op.type === "delete") {
          await this.remoteStore.delete(op.key);
        } else {
          const localData = await this.localStore.read(op.key);
          if (!localData) continue;

          const remoteData = await this.remoteStore.fetch(op.key);
          
          if (remoteData && this.hasConflict(localData.data, remoteData)) {
            const resolved = await this.conflictResolver.resolve(
              localData.data,
              remoteData
            );
            await this.remoteStore.save(op.key, resolved);
            await this.localStore.write(op.key, resolved);
          } else {
            await this.remoteStore.save(op.key, localData.data);
          }
        }
        this.syncQueue.dequeue(op.id);
      } catch (error) {
        console.error(`Failed to sync operation ${op.id}:`, error);
        this.syncQueue.markRetry(op.id);
      }
    }

    this.syncInProgress = false;
  }

  private hasConflict(local: T, remote: T): boolean {
    return remote.updatedAt > local.updatedAt;
  }
}

// Conflict resolution strategies
interface ConflictResolver<T> {
  resolve(local: T, remote: T): Promise<T>;
}

class LastWriteWinsResolver<T extends { updatedAt: Date }> implements ConflictResolver<T> {
  async resolve(local: T, remote: T): Promise<T> {
    return local.updatedAt >= remote.updatedAt ? local : remote;
  }
}

class MergeResolver<T extends Record<string, unknown> & { updatedAt: Date }> 
  implements ConflictResolver<T> {
  async resolve(local: T, remote: T): Promise<T> {
    // Field-level merge: take newest value per field
    const merged = { ...remote };
    for (const key of Object.keys(local) as Array<keyof T>) {
      if (key === "updatedAt") continue;
      // Simplified: in production use vector clocks per field
      merged[key as keyof typeof merged] = local.updatedAt >= remote.updatedAt 
        ? local[key] as typeof merged[typeof key]
        : remote[key] as typeof merged[typeof key];
    }
    merged.updatedAt = new Date(
      Math.max(local.updatedAt.getTime(), remote.updatedAt.getTime())
    ) as T["updatedAt"];
    return merged as T;
  }
}
```

---

## 2.4 AI-Specific Offline Patterns

```typescript
// Offline AI conversation manager
interface AIConversation {
  id: string;
  messages: Array<{
    id: string;
    role: "user" | "assistant" | "system";
    content: string;
    createdAt: Date;
    syncStatus: "synced" | "pending" | "failed";
  }>;
  modelId: string;
  createdAt: Date;
  updatedAt: Date;
  isArchived: boolean;
}

// Offline-capable prompt cache
class OfflinePromptCache {
  private cache = new Map<string, { response: string; timestamp: Date; ttl: number }>();

  set(promptHash: string, response: string, ttlMs: number = 3600000): void {
    this.cache.set(promptHash, {
      response,
      timestamp: new Date(),
      ttl: ttlMs,
    });
  }

  get(promptHash: string): string | null {
    const entry = this.cache.get(promptHash);
    if (!entry) return null;

    const age = Date.now() - entry.timestamp.getTime();
    if (age > entry.ttl) {
      this.cache.delete(promptHash);
      return null;
    }

    return entry.response;
  }

  // Hash prompt for cache key
  static hash(prompt: string, model: string, temperature: number): string {
    const content = `${model}:${temperature}:${prompt}`;
    // Simple hash - in production use SHA-256
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      hash = (hash << 5) - hash + content.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash).toString(36);
  }
}

// Offline-first AI feature flags
interface FeatureFlag {
  name: string;
  enabled: boolean;
  rolloutPercentage: number;
  lastUpdated: Date;
}

class OfflineFeatureFlags {
  private flags: Map<string, FeatureFlag>;
  private readonly storageKey = "ai_feature_flags";

  constructor() {
    this.flags = this.loadFromStorage();
  }

  isEnabled(flagName: string, userId: string): boolean {
    const flag = this.flags.get(flagName);
    if (!flag || !flag.enabled) return false;

    // Deterministic rollout based on userId hash
    const hash = this.hashUserId(userId + flagName);
    return hash < flag.rolloutPercentage;
  }

  update(flags: FeatureFlag[]): void {
    flags.forEach((f) => this.flags.set(f.name, f));
    this.saveToStorage();
  }

  private hashUserId(input: string): number {
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
      hash = (hash << 5) - hash + input.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash) % 100;
  }

  private loadFromStorage(): Map<string, FeatureFlag> {
    if (typeof localStorage === "undefined") return new Map();
    try {
      const stored = localStorage.getItem(this.storageKey);
      if (!stored) return new Map();
      const flags = JSON.parse(stored) as FeatureFlag[];
      return new Map(flags.map((f) => [f.name, f]));
    } catch {
      return new Map();
    }
  }

  private saveToStorage(): void {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(
      this.storageKey,
      JSON.stringify(Array.from(this.flags.values()))
    );
  }
}
```

---

## 2.5 Offline-First State Machine với XState-style

```typescript
// Simplified state machine cho offline sync
type SyncState =
  | { type: "idle" }
  | { type: "checking"; since: Date }
  | { type: "syncing"; total: number; completed: number }
  | { type: "conflict"; conflicts: Array<{ key: string }> }
  | { type: "error"; error: Error; retryAfter: Date }
  | { type: "complete"; syncedAt: Date; count: number };

type SyncEvent =
  | { type: "START_SYNC" }
  | { type: "ITEMS_FOUND"; count: number }
  | { type: "ITEM_SYNCED" }
  | { type: "CONFLICT_DETECTED"; key: string }
  | { type: "CONFLICT_RESOLVED" }
  | { type: "SYNC_COMPLETE"; count: number }
  | { type: "ERROR"; error: Error }
  | { type: "RETRY" };

function syncReducer(state: SyncState, event: SyncEvent): SyncState {
  switch (state.type) {
    case "idle":
      if (event.type === "START_SYNC") {
        return { type: "checking", since: new Date() };
      }
      return state;

    case "checking":
      if (event.type === "ITEMS_FOUND") {
        return { type: "syncing", total: event.count, completed: 0 };
      }
      if (event.type === "SYNC_COMPLETE") {
        return { type: "complete", syncedAt: new Date(), count: event.count };
      }
      return state;

    case "syncing": {
      if (event.type === "ITEM_SYNCED") {
        const completed = state.completed + 1;
        if (completed >= state.total) {
          return {
            type: "complete",
            syncedAt: new Date(),
            count: state.total,
          };
        }
        return { ...state, completed };
      }
      if (event.type === "CONFLICT_DETECTED") {
        return {
          type: "conflict",
          conflicts: [{ key: event.key }],
        };
      }
      if (event.type === "ERROR") {
        const retryAfter = new Date(Date.now() + 30000); // 30s
        return { type: "error", error: event.error, retryAfter };
      }
      return state;
    }

    case "conflict":
      if (event.type === "CONFLICT_RESOLVED") {
        return { type: "idle" };
      }
      return state;

    case "error":
      if (event.type === "RETRY") {
        return { type: "idle" };
      }
      return state;

    case "complete":
      if (event.type === "START_SYNC") {
        return { type: "checking", since: new Date() };
      }
      return state;
  }
}

// Usage với React hook (works offline too)
function useSyncState() {
  // In real app, use React.useReducer
  let state: SyncState = { type: "idle" };

  function dispatch(event: SyncEvent): void {
    state = syncReducer(state, event);
    console.log("New sync state:", state);
  }

  return { state, dispatch };
}
```

---

## Tóm tắt Bài 2

| Pattern | Use Case | TypeScript Feature |
|---------|----------|--------------------|
| Storage Strategies | Cache-first, Network-first | Discriminated Unions |
| Sync Queue | Offline write persistence | Generic classes |
| Conflict Resolution | Last-write-wins, Field merge | Strategy pattern |
| State Machine | Sync status tracking | Discriminated Union reducers |
| Feature Flags | Offline-safe feature rollout | Map + localStorage |

## Bài tập thực hành

1. Implement một `OfflineFirstHook` cho React sử dụng `useReducer` với `syncReducer` ở trên, tích hợp với `NetworkStatusManager`.
2. Thêm **TTL (Time-To-Live)** cho local storage — entries cũ hơn X giờ sẽ bị invalidate và re-fetch.
3. Implement **Pessimistic Offline Mode**: khi detect mạng chậm (> 2000ms latency), tự động switch sang cache-first strategy.

---

*Tiếp theo: [Bài 3 — Local-First Data Layer với IndexedDB & PouchDB](03-local-data-layer-indexeddb-pouchdb.md)*

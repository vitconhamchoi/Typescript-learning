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

Discriminated union định nghĩa các strategy khác nhau:

```typescript
type CacheStrategy =
  | "cache-first"             // serve from cache, refresh in background
  | "network-first"           // try network, fallback to cache
  | "stale-while-revalidate"  // serve cache immediately, refresh async
  | "network-only"            // never use cache
  | "cache-only";             // never hit network
```

Cache entry với TTL và metadata:

```typescript
interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
  etag?: string;
}
```

---

## 2.3 Network Status Detection

Monitor network trạng thái và notify listeners khi thay đổi:

```typescript
type NetworkStatus = "online" | "offline" | "slow";

class NetworkMonitor {
  private _status: NetworkStatus = "online";
  get isOnline(): boolean { return this._status !== "offline"; }
  onChange(listener: (status: NetworkStatus) => void): void { /* ... */ }
}
```

---

## 2.4 Offline Operation Queue

Queue operations khi offline, flush khi online với exponential backoff:

```typescript
interface QueuedOperation {
  id: string;
  type: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
  nextRetryAt: number;
}
```

Backoff strategy khi retry:

```typescript
const backoff = Math.min(1000 * 2 ** op.attempts, 30_000);
const jitter  = Math.random() * 1000;
op.nextRetryAt = Date.now() + backoff + jitter;
```

---

## 2.5 Sync State Machine

Finite state machine track trạng thái sync:

```typescript
type SyncState = "idle" | "syncing" | "error" | "paused";

type SyncEvent =
  | { type: "START" }
  | { type: "SUCCESS" }
  | { type: "FAILURE"; error: Error }
  | { type: "PAUSE" }
  | { type: "RESUME" };
```

Transition table define valid state changes:

```typescript
const TRANSITIONS: Record<SyncState, Partial<Record<SyncEvent["type"], SyncState>>> = {
  idle:    { START: "syncing" },
  syncing: { SUCCESS: "idle", FAILURE: "error", PAUSE: "paused" },
  error:   { START: "syncing", PAUSE: "paused" },
  paused:  { RESUME: "idle", START: "syncing" },
};
```

---

## 2.6 AI-Specific Offline Patterns

Prompt cache giúp serve LLM responses offline dựa trên hash:

```typescript
class OfflinePromptCache {
  private cache = new Map<string, { response: string; timestamp: number; ttl: number }>();

  get(promptHash: string): string | null { /* check TTL, return or null */ }
  set(promptHash: string, response: string, ttlMs: number): void { /* store */ }

  static hash(prompt: string, model: string, temp: number): string {
    // Simple hash from prompt + model + temperature
  }
}
```

Conflict resolution strategies cho sync:

```typescript
interface ConflictResolver<T> {
  resolve(local: T, remote: T): Promise<T>;
}

// Last-write-wins: so sánh updatedAt
// Field-level merge: merge từng field theo timestamp
```

---

## Tóm tắt Bài 2

| Pattern | Use Case | TypeScript Feature |
|---------|----------|--------------------|
| Storage Strategies | Cache-first, Network-first | Discriminated Unions |
| Sync Queue | Offline write persistence | Generic classes |
| Conflict Resolution | Last-write-wins, Field merge | Strategy pattern |
| State Machine | Sync status tracking | Discriminated Union reducers |
| Prompt Cache | Offline AI responses | Map + TTL |

## Bài tập thực hành

1. Implement một `OfflineFirstHook` cho React sử dụng `useReducer` với `syncReducer` ở trên, tích hợp với `NetworkStatusManager`.
2. Thêm **TTL (Time-To-Live)** cho local storage — entries cũ hơn X giờ sẽ bị invalidate và re-fetch.
3. Implement **Pessimistic Offline Mode**: khi detect mạng chậm (> 2000ms latency), tự động switch sang cache-first strategy.

---

*Tiếp theo: [Bài 3 — Local-First Data Layer với IndexedDB & PouchDB](03-local-data-layer-indexeddb-pouchdb.md)*

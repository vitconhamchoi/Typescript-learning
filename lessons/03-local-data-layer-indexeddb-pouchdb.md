# Bài 3: Local-First Data Layer với IndexedDB & PouchDB

## Mục tiêu bài học

- Xây dựng type-safe wrapper cho IndexedDB từ đầu
- Sử dụng Dexie.js — IndexedDB wrapper tốt nhất với TypeScript
- Tích hợp PouchDB cho offline-sync với CouchDB/remote
- Thiết kế schema migration strategy cho AI app data

---

## 3.1 Type-Safe IndexedDB Wrapper

IndexedDB rất mạnh nhưng API cồng kềnh. Ta sẽ wrap nó với TypeScript generics.

```typescript
// Schema definition — mỗi store có key type, value type, indexes
interface DBSchema {
  [storeName: string]: {
    key: IDBValidKey;
    value: Record<string, unknown>;
    indexes?: Record<string, IDBValidKey>;
  };
}

// Type-safe wrapper — generic schema constraint đảm bảo đúng store/key/value
class TypedIDB<Schema extends DBSchema> {
  async get<S extends keyof Schema & string>(
    store: S, key: Schema[S]["key"]
  ): Promise<Schema[S]["value"] | undefined> { /* ... */ }

  async put<S extends keyof Schema & string>(
    store: S, value: Schema[S]["value"]
  ): Promise<Schema[S]["key"]> { /* ... */ }
}
```

Migration interface cho schema upgrades:

```typescript
interface Migration {
  version: number;
  up: (db: IDBDatabase, tx: IDBTransaction) => void;
  down?: (db: IDBDatabase, tx: IDBTransaction) => void;
}
```

---

## 3.2 AI App Schema với Dexie.js

Dexie.js là thư viện tốt nhất để làm việc với IndexedDB. Hãy thiết kế schema cho AI app:

```typescript
// Entity types cho AI app
interface DBConversation {
  id: string;
  userId: string;
  title: string;
  modelId: string;
  syncStatus: "synced" | "pending" | "conflict";
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
}

// Dexie DB class với versioned schema migrations
class AIAppDatabase extends Dexie {
  conversations!: Table<DBConversation>;
  messages!: Table<DBMessage>;

  constructor() {
    super("AIAppDB");
    this.version(1).stores({
      conversations: "id, userId, updatedAt, syncStatus, *tags",
      messages: "id, conversationId, createdAt, role",
    });
  }
}
```

---

## 3.3 Repository Pattern cho AI Data

```typescript
// Generic repository interface — type-safe CRUD
interface Repository<T extends BaseEntity> {
  findById(id: string): Promise<T | null>;
  findMany(opts?: FindOptions<T>): Promise<T[]>;
  create(data: Omit<T, keyof BaseEntity>): Promise<T>;
  update(id: string, patch: Partial<Omit<T, keyof BaseEntity>>): Promise<T>;
  softDelete(id: string): Promise<void>;
}

// Type-safe query filters
type WhereClause<T> = {
  [K in keyof T]?: T[K] | { $in: T[K][] } | { $gt: T[K] } | { $lt: T[K] };
};
```

Cosine similarity cho client-side vector search:

```typescript
// Client-side vector search (for small embedding collections)
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
```

Response cache với TTL:

```typescript
// Response cache — hash prompt+model → cached response
interface CachedResponse {
  cacheKey: string;
  prompt: string;
  response: string;
  model: string;
  expiresAt: Date;
  hitCount: number;
}

// Cache key = deterministic hash of prompt + model + temperature
function buildCacheKey(prompt: string, model: string, temp: number): string {
  let hash = 5381;
  for (const ch of `${model}:${temp}:${prompt}`)
    hash = ((hash << 5) + hash + ch.charCodeAt(0)) | 0;
  return Math.abs(hash).toString(36);
}
```

---

## 3.4 PouchDB cho Offline-Sync với Remote CouchDB

PouchDB sync tự động với CouchDB/Cloudant, hoàn hảo cho offline-first AI apps:

```typescript
// PouchDB document types — extends _id/_rev
interface PouchDocument {
  _id: string;
  _rev?: string;
  _deleted?: boolean;
}

interface ConversationDoc extends PouchDocument {
  type: "conversation";
  userId: string;
  title: string;
  version: number;
}
```

Optimistic update pattern — apply ngay, rollback nếu server reject:

```typescript
interface OptimisticUpdate<T> {
  id: string;
  original: T | null;
  optimistic: T;
  status: "pending" | "confirmed" | "failed";
}

// Apply optimistic → return rollback function
function applyOptimistic<T>(store: Map<string, T>, id: string, value: T): () => void {
  const original = store.get(id) ?? null;
  store.set(id, value);
  return () => { original ? store.set(id, original) : store.delete(id); };
}
```

Sync manager pattern:

```typescript
// Live sync với conflict detection
class PouchSyncManager {
  startLiveSync(): void {
    this.localDb.sync(this.remoteDb, {
      live: true,
      retry: true,
    })
    .on("change", (info) => console.log("Sync change:", info))
    .on("paused", () => console.log("Up-to-date or offline"))
    .on("error", (err) => console.error("Sync error:", err));
  }
}
```

---

## 3.5 Database Migration Strategy

```typescript
// Migration definition với up/down
interface MigrationDefinition {
  version: number;
  name: string;
  description: string;
  up: (db: Database) => Promise<void>;
  down?: (db: Database) => Promise<void>;
}

// Runner chạy pending migrations theo thứ tự version
const pending = migrations
  .filter(m => m.version > currentVersion)
  .sort((a, b) => a.version - b.version);
for (const m of pending) await m.up(db);
```

---

## Tóm tắt Bài 3

| Tool | Use Case | Khi nào dùng |
|------|----------|--------------|
| Raw IndexedDB | Maximum control, no dependencies | Khi cần bundle size nhỏ nhất |
| Dexie.js | Best TypeScript support, migrations | Hầu hết ứng dụng AI |
| PouchDB | Auto-sync với CouchDB/Cloudant | Khi cần real-time sync |

## Bài tập thực hành

1. Implement `ConversationRepository.searchByTag()` để search conversations theo tag với Dexie full-text search.
2. Thêm **automatic cache eviction**: khi IndexedDB đầy (> quota threshold), tự động xóa các cached responses ít được dùng nhất.
3. Implement **PouchDB conflict resolution UI**: detect conflicts, hiển thị diff, cho phép user chọn version nào giữ.

---

*Tiếp theo: [Bài 4 — CRDTs: Conflict-Free Replicated Data Types](04-crdts-conflict-free-data.md)*

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
// Schema definition type
interface DBSchema {
  [storeName: string]: {
    key: IDBValidKey;
    value: Record<string, unknown>;
    indexes?: Record<string, IDBValidKey>;
  };
}

// Type-safe IDB wrapper
class TypedIDB<Schema extends DBSchema> {
  private db: IDBDatabase | null = null;

  constructor(
    private dbName: string,
    private version: number,
    private migrations: Migration[]
  ) {}

  async open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.version);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        const tx = (event.target as IDBOpenDBRequest).transaction!;
        const oldVersion = event.oldVersion;

        // Run migrations in order
        this.migrations
          .filter((m) => m.version > oldVersion)
          .sort((a, b) => a.version - b.version)
          .forEach((m) => m.up(db, tx));
      };
    });
  }

  async get<Store extends keyof Schema & string>(
    store: Store,
    key: Schema[Store]["key"]
  ): Promise<Schema[Store]["value"] | undefined> {
    return this.runTransaction(store, "readonly", (objectStore) => {
      return new Promise((resolve, reject) => {
        const request = objectStore.get(key as IDBValidKey);
        request.onsuccess = () => resolve(request.result as Schema[Store]["value"]);
        request.onerror = () => reject(request.error);
      });
    });
  }

  async put<Store extends keyof Schema & string>(
    store: Store,
    value: Schema[Store]["value"],
    key?: Schema[Store]["key"]
  ): Promise<Schema[Store]["key"]> {
    return this.runTransaction(store, "readwrite", (objectStore) => {
      return new Promise((resolve, reject) => {
        const request = objectStore.put(value, key as IDBValidKey | undefined);
        request.onsuccess = () => resolve(request.result as Schema[Store]["key"]);
        request.onerror = () => reject(request.error);
      });
    });
  }

  async delete<Store extends keyof Schema & string>(
    store: Store,
    key: Schema[Store]["key"]
  ): Promise<void> {
    return this.runTransaction(store, "readwrite", (objectStore) => {
      return new Promise((resolve, reject) => {
        const request = objectStore.delete(key as IDBValidKey);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    });
  }

  async getAll<Store extends keyof Schema & string>(
    store: Store,
    query?: IDBKeyRange,
    count?: number
  ): Promise<Schema[Store]["value"][]> {
    return this.runTransaction(store, "readonly", (objectStore) => {
      return new Promise((resolve, reject) => {
        const request = objectStore.getAll(query, count);
        request.onsuccess = () => resolve(request.result as Schema[Store]["value"][]);
        request.onerror = () => reject(request.error);
      });
    });
  }

  async getByIndex<Store extends keyof Schema & string>(
    store: Store,
    indexName: keyof Schema[Store]["indexes"] & string,
    value: IDBValidKey
  ): Promise<Schema[Store]["value"][]> {
    return this.runTransaction(store, "readonly", (objectStore) => {
      return new Promise((resolve, reject) => {
        const index = objectStore.index(indexName);
        const request = index.getAll(value);
        request.onsuccess = () => resolve(request.result as Schema[Store]["value"][]);
        request.onerror = () => reject(request.error);
      });
    });
  }

  async count<Store extends keyof Schema & string>(store: Store): Promise<number> {
    return this.runTransaction(store, "readonly", (objectStore) => {
      return new Promise((resolve, reject) => {
        const request = objectStore.count();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    });
  }

  private async runTransaction<T>(
    store: string,
    mode: IDBTransactionMode,
    fn: (objectStore: IDBObjectStore) => Promise<T>
  ): Promise<T> {
    if (!this.db) throw new Error("Database not opened");
    const tx = this.db.transaction(store, mode);
    const objectStore = tx.objectStore(store);
    return fn(objectStore);
  }
}

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
import Dexie, { type Table } from "dexie";

// ============ SCHEMA TYPES ============

interface DBConversation {
  id: string;
  userId: string;
  title: string;
  modelId: string;
  systemPrompt: string;
  createdAt: Date;
  updatedAt: Date;
  isArchived: boolean;
  isPinned: boolean;
  tokenCount: number;
  tags: string[];
  syncStatus: "synced" | "pending" | "conflict";
  localVersion: number;
  remoteVersion: number | null;
}

interface DBMessage {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  createdAt: Date;
  tokenCount: number;
  model: string;
  syncStatus: "synced" | "pending" | "failed";
  parentMessageId: string | null;
}

interface DBEmbedding {
  id: string;
  documentId: string;
  content: string;
  vector: number[];
  model: string;
  dimensions: number;
  createdAt: Date;
  metadata: Record<string, unknown>;
}

interface DBDocument {
  id: string;
  title: string;
  content: string;
  contentHash: string;
  mimeType: string;
  size: number;
  createdAt: Date;
  updatedAt: Date;
  embeddingStatus: "pending" | "processing" | "complete" | "failed";
  chunkCount: number;
  tags: string[];
}

interface DBCachedResponse {
  cacheKey: string;
  prompt: string;
  response: string;
  model: string;
  temperature: number;
  createdAt: Date;
  expiresAt: Date;
  hitCount: number;
}

interface DBSyncOperation {
  id: string;
  type: "create" | "update" | "delete";
  entityType: "conversation" | "message" | "document";
  entityId: string;
  data: string; // JSON stringified
  createdAt: Date;
  retryCount: number;
  lastError: string | null;
}

interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

interface ToolResult {
  toolCallId: string;
  content: string;
}

// ============ DEXIE DATABASE CLASS ============

class AIAppDatabase extends Dexie {
  conversations!: Table<DBConversation>;
  messages!: Table<DBMessage>;
  embeddings!: Table<DBEmbedding>;
  documents!: Table<DBDocument>;
  cachedResponses!: Table<DBCachedResponse>;
  syncOperations!: Table<DBSyncOperation>;

  constructor() {
    super("AIAppDB");

    // Version 1: Initial schema
    this.version(1).stores({
      conversations: "id, userId, updatedAt, isArchived, syncStatus, *tags",
      messages: "id, conversationId, createdAt, role, syncStatus",
      embeddings: "id, documentId, model",
      documents: "id, contentHash, embeddingStatus, *tags",
      cachedResponses: "cacheKey, model, expiresAt",
      syncOperations: "id, type, entityType, createdAt",
    });

    // Version 2: Add isPinned to conversations
    this.version(2).stores({
      conversations: "id, userId, updatedAt, isArchived, isPinned, syncStatus, *tags",
    });

    // Version 3: Add parentMessageId for branching conversations
    this.version(3)
      .stores({
        messages: "id, conversationId, createdAt, role, syncStatus, parentMessageId",
      })
      .upgrade(async (tx) => {
        // Migrate existing messages to have null parentMessageId
        await tx
          .table("messages")
          .toCollection()
          .modify({ parentMessageId: null });
      });
  }
}

// Singleton instance
export const db = new AIAppDatabase();
```

---

## 3.3 Repository Pattern cho AI Data

```typescript
// Base repository với common CRUD
abstract class BaseRepository<T extends { id: string; updatedAt: Date }> {
  protected abstract table: Table<T>;

  async findById(id: string): Promise<T | undefined> {
    return this.table.get(id);
  }

  async findMany(ids: string[]): Promise<T[]> {
    return this.table.where("id").anyOf(ids).toArray();
  }

  async save(entity: T): Promise<void> {
    await this.table.put(entity);
  }

  async saveMany(entities: T[]): Promise<void> {
    await this.table.bulkPut(entities);
  }

  async delete(id: string): Promise<void> {
    await this.table.delete(id);
  }

  async count(): Promise<number> {
    return this.table.count();
  }
}

// Conversation repository
class ConversationRepository extends BaseRepository<DBConversation> {
  protected table = db.conversations;

  async findByUser(userId: string, options?: {
    includeArchived?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<DBConversation[]> {
    let query = this.table.where("userId").equals(userId);
    
    if (!options?.includeArchived) {
      // Dexie doesn't support compound where easily, filter after
      const results = await query.toArray();
      return results
        .filter((c) => !c.isArchived)
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
        .slice(options?.offset ?? 0, (options?.offset ?? 0) + (options?.limit ?? 50));
    }
    
    return query
      .sortBy("updatedAt")
      .then((results) =>
        results
          .reverse()
          .slice(options?.offset ?? 0, (options?.offset ?? 0) + (options?.limit ?? 50))
      );
  }

  async findPending(): Promise<DBConversation[]> {
    return this.table.where("syncStatus").equals("pending").toArray();
  }

  async search(userId: string, query: string): Promise<DBConversation[]> {
    const lowerQuery = query.toLowerCase();
    return this.table
      .where("userId")
      .equals(userId)
      .and((conv) => conv.title.toLowerCase().includes(lowerQuery))
      .toArray();
  }

  async markSynced(id: string, remoteVersion: number): Promise<void> {
    await this.table.update(id, {
      syncStatus: "synced",
      remoteVersion,
    });
  }
}

// Message repository with advanced querying
class MessageRepository extends BaseRepository<DBMessage> {
  protected table = db.messages;

  async findByConversation(
    conversationId: string,
    options?: { limit?: number; before?: Date }
  ): Promise<DBMessage[]> {
    let collection = this.table
      .where("conversationId")
      .equals(conversationId);

    const messages = await collection.sortBy("createdAt");

    if (options?.before) {
      return messages
        .filter((m) => m.createdAt < options.before!)
        .slice(-(options.limit ?? 50));
    }

    return messages.slice(-(options?.limit ?? 50));
  }

  async getConversationContext(
    conversationId: string,
    maxTokens: number
  ): Promise<DBMessage[]> {
    const messages = await this.findByConversation(conversationId, { limit: 100 });
    
    // Build context window respecting token limit
    const context: DBMessage[] = [];
    let tokenCount = 0;
    
    for (const message of messages.reverse()) {
      if (tokenCount + message.tokenCount > maxTokens) break;
      context.unshift(message);
      tokenCount += message.tokenCount;
    }
    
    return context;
  }

  async countPending(): Promise<number> {
    return this.table.where("syncStatus").equals("pending").count();
  }

  async markFailed(id: string): Promise<void> {
    await this.table.update(id, { syncStatus: "failed" });
  }
}

// Embedding repository with vector search support
class EmbeddingRepository extends BaseRepository<DBEmbedding> {
  protected table = db.embeddings;

  async findByDocument(documentId: string): Promise<DBEmbedding[]> {
    return this.table.where("documentId").equals(documentId).toArray();
  }

  // Client-side vector search (for small collections)
  // For large collections, use a vector DB (Bài 15)
  async similaritySearch(
    queryVector: number[],
    options: {
      topK?: number;
      threshold?: number;
      filter?: Partial<DBEmbedding>;
    } = {}
  ): Promise<Array<DBEmbedding & { similarity: number }>> {
    const { topK = 5, threshold = 0.7, filter } = options;

    let collection = this.table.toCollection();
    
    if (filter?.model) {
      collection = this.table.where("model").equals(filter.model);
    }

    const all = await collection.toArray();
    
    return all
      .map((embedding) => ({
        ...embedding,
        similarity: this.cosineSimilarity(queryVector, embedding.vector),
      }))
      .filter((e) => e.similarity >= threshold)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topK);
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}

// Response cache repository
class ResponseCacheRepository {
  private table = db.cachedResponses;

  async get(cacheKey: string): Promise<DBCachedResponse | null> {
    const entry = await this.table.get(cacheKey);
    if (!entry) return null;
    
    // Check expiry
    if (entry.expiresAt < new Date()) {
      await this.table.delete(cacheKey);
      return null;
    }
    
    // Update hit count
    await this.table.update(cacheKey, { hitCount: entry.hitCount + 1 });
    return entry;
  }

  async set(
    params: {
      prompt: string;
      model: string;
      temperature: number;
      response: string;
    },
    ttlMs: number = 3600000
  ): Promise<void> {
    const cacheKey = this.buildKey(params.prompt, params.model, params.temperature);
    await this.table.put({
      cacheKey,
      prompt: params.prompt,
      response: params.response,
      model: params.model,
      temperature: params.temperature,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + ttlMs),
      hitCount: 0,
    });
  }

  async purgeExpired(): Promise<number> {
    const now = new Date();
    const expired = await this.table.where("expiresAt").below(now).toArray();
    await this.table.where("expiresAt").below(now).delete();
    return expired.length;
  }

  private buildKey(prompt: string, model: string, temperature: number): string {
    const content = `${model}:${temperature}:${prompt}`;
    // Simple deterministic hash
    let hash = 5381;
    for (let i = 0; i < content.length; i++) {
      hash = ((hash << 5) + hash) + content.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash).toString(36);
  }
}
```

---

## 3.4 PouchDB cho Offline-Sync với Remote CouchDB

PouchDB sync tự động với CouchDB/Cloudant, hoàn hảo cho offline-first AI apps:

```typescript
import PouchDB from "pouchdb";
import PouchDBFind from "pouchdb-find";

PouchDB.plugin(PouchDBFind);

// Type-safe PouchDB documents
interface PouchDocument {
  _id: string;
  _rev?: string;
  _deleted?: boolean;
}

interface ConversationDoc extends PouchDocument {
  type: "conversation";
  userId: string;
  title: string;
  modelId: string;
  messages: MessageDoc[];
  createdAt: string; // ISO string (PouchDB stores dates as strings)
  updatedAt: string;
  isArchived: boolean;
  version: number;
}

interface MessageDoc extends PouchDocument {
  type: "message";
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  tokenCount: number;
}

// PouchDB Sync Manager
class PouchSyncManager {
  private localDb: PouchDB.Database;
  private remoteDb: PouchDB.Database | null = null;
  private syncHandler: PouchDB.Replication.Sync<object> | null = null;

  constructor(localDbName: string) {
    this.localDb = new PouchDB(localDbName);
  }

  async connectRemote(remoteUrl: string, credentials?: { username: string; password: string }): Promise<void> {
    this.remoteDb = new PouchDB(remoteUrl, {
      auth: credentials,
    });

    // Test connection
    await this.remoteDb.info();
    console.log("Connected to remote CouchDB");
  }

  // Start live sync
  startLiveSync(options?: {
    onConflict?: (doc: PouchDB.Core.ExistingDocument<object>) => void;
    onError?: (error: Error) => void;
    onPaused?: () => void;
    onActive?: () => void;
  }): void {
    if (!this.remoteDb) throw new Error("Remote DB not connected");

    this.syncHandler = this.localDb
      .sync(this.remoteDb, {
        live: true,
        retry: true,
        filter: (doc: PouchDB.Core.Document<object> & { type?: string }) => {
          // Only sync conversation-related documents
          return ["conversation", "message"].includes(doc.type ?? "");
        },
      })
      .on("change", (change) => {
        console.log("Sync change:", change);
      })
      .on("paused", () => {
        console.log("Sync paused (offline or up-to-date)");
        options?.onPaused?.();
      })
      .on("active", () => {
        console.log("Sync active");
        options?.onActive?.();
      })
      .on("denied", (error) => {
        console.error("Sync denied:", error);
      })
      .on("error", (error) => {
        console.error("Sync error:", error);
        options?.onError?.(error as Error);
      });
  }

  stopSync(): void {
    this.syncHandler?.cancel();
    this.syncHandler = null;
  }

  // Type-safe document operations
  async saveConversation(conv: Omit<ConversationDoc, "_id" | "_rev">): Promise<ConversationDoc> {
    const id = `conversation:${crypto.randomUUID()}`;
    const response = await this.localDb.put({ ...conv, _id: id });
    return { ...conv, _id: id, _rev: response.rev };
  }

  async getConversation(id: string): Promise<ConversationDoc | null> {
    try {
      return await this.localDb.get<ConversationDoc>(id);
    } catch (error) {
      if ((error as { status?: number }).status === 404) return null;
      throw error;
    }
  }

  async updateConversation(
    id: string,
    updates: Partial<Omit<ConversationDoc, "_id" | "_rev" | "type">>
  ): Promise<void> {
    const existing = await this.getConversation(id);
    if (!existing) throw new Error(`Conversation ${id} not found`);

    await this.localDb.put({
      ...existing,
      ...updates,
      updatedAt: new Date().toISOString(),
      version: existing.version + 1,
    });
  }

  // PouchDB Find plugin for queries
  async findConversationsByUser(userId: string): Promise<ConversationDoc[]> {
    await this.ensureIndex({ fields: ["type", "userId", "updatedAt"] });

    const result = await this.localDb.find({
      selector: {
        type: "conversation",
        userId,
        isArchived: { $ne: true },
      },
      sort: [{ updatedAt: "desc" }],
      limit: 50,
    });

    return result.docs as ConversationDoc[];
  }

  // Conflict resolution
  async resolveConflict(id: string, strategy: "keep-local" | "keep-remote" | "merge"): Promise<void> {
    const doc = await this.localDb.get<ConversationDoc>(id, { conflicts: true });
    
    if (!doc._conflicts || doc._conflicts.length === 0) return;

    if (strategy === "keep-local") {
      // Delete all conflicting revisions
      for (const conflictRev of doc._conflicts) {
        await this.localDb.remove(id, conflictRev);
      }
    } else if (strategy === "keep-remote" && this.remoteDb) {
      const remoteDoc = await this.remoteDb.get<ConversationDoc>(id);
      await this.localDb.put({ ...remoteDoc });
    }
  }

  private async ensureIndex(config: { fields: string[] }): Promise<void> {
    await this.localDb.createIndex({ index: config });
  }
}
```

---

## 3.5 Database Migration Strategy

```typescript
// Safe database migration với rollback support
interface MigrationDefinition {
  version: number;
  name: string;
  description: string;
  up: (db: AIAppDatabase) => Promise<void>;
  down?: (db: AIAppDatabase) => Promise<void>;
}

const migrations: MigrationDefinition[] = [
  {
    version: 1,
    name: "initial-schema",
    description: "Create initial tables",
    async up(db) {
      // Dexie handles this via .version().stores()
      console.log("Migration 1: Initial schema created");
    },
  },
  {
    version: 2,
    name: "add-conversation-pinning",
    description: "Add isPinned field to conversations",
    async up(db) {
      // Migrate existing conversations
      await db.conversations.toCollection().modify({ isPinned: false });
      console.log("Migration 2: Added isPinned to conversations");
    },
    async down(db) {
      // Can't truly rollback IndexedDB schema changes
      console.warn("Migration 2 rollback: isPinned remains but schema reverted");
    },
  },
  {
    version: 3,
    name: "add-message-branching",
    description: "Add parentMessageId for conversation branching",
    async up(db) {
      await db.messages.toCollection().modify({ parentMessageId: null });
      console.log("Migration 3: Added parentMessageId to messages");
    },
  },
];

// Migration runner
class DatabaseMigrationRunner {
  async run(db: AIAppDatabase, targetVersion?: number): Promise<void> {
    const currentVersion = db.verno;
    const target = targetVersion ?? Math.max(...migrations.map((m) => m.version));

    console.log(`Database migration: v${currentVersion} -> v${target}`);

    const pendingMigrations = migrations
      .filter((m) => m.version > currentVersion && m.version <= target)
      .sort((a, b) => a.version - b.version);

    for (const migration of pendingMigrations) {
      console.log(`Running migration ${migration.version}: ${migration.name}`);
      try {
        await migration.up(db);
        console.log(`Migration ${migration.version} complete`);
      } catch (error) {
        console.error(`Migration ${migration.version} failed:`, error);
        throw error;
      }
    }
  }
}
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

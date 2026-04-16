/**
 * Bài 3: Local-First Data Layer — IndexedDB & PouchDB (Node simulation)
 * ======================================================================
 * Chạy: npm run lesson03
 *
 * Nội dung:
 *  - Generic typed repository interface
 *  - In-memory implementation (mirrors IndexedDB / Dexie.js API)
 *  - Query builder with type-safe filters
 *  - Optimistic update pattern
 *  - Sync watermark / checkpoint
 *  - Response cache with TTL
 *  - Embedding store with cosine similarity
 *  - Migration system
 *  - Sync manager (PouchDB-like)
 */

// ─────────────────────────────────────────────────────────────────────────────
// 1. CORE ENTITY TYPES
// ─────────────────────────────────────────────────────────────────────────────

type ISO8601 = string; // "2024-01-01T00:00:00.000Z"

interface BaseEntity {
  readonly id: string;
  readonly createdAt: ISO8601;
  updatedAt: ISO8601;
  /** Logical clock for conflict detection */
  version: number;
  /** null = not deleted */
  deletedAt: ISO8601 | null;
}

interface Note extends BaseEntity {
  title: string;
  body: string;
  tags: string[];
  authorId: string;
}

interface Tag extends BaseEntity {
  name: string;
  color: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. GENERIC REPOSITORY INTERFACE
// ─────────────────────────────────────────────────────────────────────────────

type WhereClause<T> = {
  [K in keyof T]?: T[K] | { $in: T[K][] } | { $gt: T[K] } | { $lt: T[K] };
};

interface FindOptions<T> {
  where?: WhereClause<T>;
  orderBy?: { field: keyof T; dir: "asc" | "desc" };
  limit?: number;
  offset?: number;
  includeDeleted?: boolean;
}

interface Repository<T extends BaseEntity> {
  findById(id: string): Promise<T | null>;
  findMany(opts?: FindOptions<T>): Promise<T[]>;
  create(data: Omit<T, keyof BaseEntity>): Promise<T>;
  update(id: string, patch: Partial<Omit<T, keyof BaseEntity>>): Promise<T>;
  softDelete(id: string): Promise<void>;
  upsert(entity: T): Promise<T>;
  count(opts?: Pick<FindOptions<T>, "where" | "includeDeleted">): Promise<number>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. IN-MEMORY IMPLEMENTATION  (drop-in for IndexedDB / PouchDB in browser)
// ─────────────────────────────────────────────────────────────────────────────

function now(): ISO8601 { return new Date().toISOString(); }
function nanoid(): string { return Math.random().toString(36).slice(2, 11); }

function matchesWhere<T extends BaseEntity>(entity: T, where?: WhereClause<T>): boolean {
  if (!where) return true;
  for (const [key, condition] of Object.entries(where) as [keyof T, unknown][]) {
    const val = entity[key];
    if (condition === null || condition === undefined) continue;
    if (typeof condition === "object" && condition !== null) {
      const cond = condition as Record<string, unknown>;
      if ("$in"  in cond && Array.isArray(cond["$in"]) && !cond["$in"].includes(val)) return false;
      if ("$gt"  in cond && !((val as unknown as number) > (cond["$gt"] as number))) return false;
      if ("$lt"  in cond && !((val as unknown as number) < (cond["$lt"] as number))) return false;
    } else {
      if (val !== condition) return false;
    }
  }
  return true;
}

class InMemoryRepository<T extends BaseEntity> implements Repository<T> {
  protected store = new Map<string, T>();

  async findById(id: string): Promise<T | null> {
    return this.store.get(id) ?? null;
  }

  async findMany(opts: FindOptions<T> = {}): Promise<T[]> {
    const { where, orderBy, limit, offset = 0, includeDeleted = false } = opts;
    let results = [...this.store.values()].filter(e => {
      if (!includeDeleted && e.deletedAt !== null) return false;
      return matchesWhere(e, where);
    });

    if (orderBy) {
      results.sort((a, b) => {
        const av = a[orderBy.field];
        const bv = b[orderBy.field];
        const cmp = av < bv ? -1 : av > bv ? 1 : 0;
        return orderBy.dir === "asc" ? cmp : -cmp;
      });
    }

    results = results.slice(offset, limit !== undefined ? offset + limit : undefined);
    return results;
  }

  async create(data: Omit<T, keyof BaseEntity>): Promise<T> {
    const entity = {
      ...data,
      id: nanoid(),
      createdAt: now(),
      updatedAt: now(),
      version: 1,
      deletedAt: null,
    } as unknown as T;
    this.store.set(entity.id, entity);
    return entity;
  }

  async update(id: string, patch: Partial<Omit<T, keyof BaseEntity>>): Promise<T> {
    const entity = this.store.get(id);
    if (!entity) throw new Error(`Entity ${id} not found`);
    const updated = { ...entity, ...patch, updatedAt: now(), version: entity.version + 1 };
    this.store.set(id, updated);
    return updated;
  }

  async softDelete(id: string): Promise<void> {
    const entity = this.store.get(id);
    if (!entity) throw new Error(`Entity ${id} not found`);
    this.store.set(id, { ...entity, deletedAt: now(), version: entity.version + 1 });
  }

  async upsert(entity: T): Promise<T> {
    const existing = this.store.get(entity.id);
    if (existing && existing.version >= entity.version) {
      // Our copy is newer — keep it (last-write-wins by version)
      return existing;
    }
    this.store.set(entity.id, entity);
    return entity;
  }

  async count(opts: Pick<FindOptions<T>, "where" | "includeDeleted"> = {}): Promise<number> {
    const rows = await this.findMany(opts);
    return rows.length;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. OPTIMISTIC UPDATE PATTERN
// ─────────────────────────────────────────────────────────────────────────────

interface OptimisticUpdate<T> {
  id: string;
  original: T | null;
  optimistic: T;
  status: "pending" | "confirmed" | "failed";
}

class OptimisticStore<T extends BaseEntity> extends InMemoryRepository<T> {
  private pending = new Map<string, OptimisticUpdate<T>>();

  /** Apply an optimistic change immediately; return rollback fn */
  applyOptimistic(optimistic: T): () => void {
    const original = this.store.get(optimistic.id) ?? null;
    const update: OptimisticUpdate<T> = { id: optimistic.id, original, optimistic, status: "pending" };
    this.pending.set(optimistic.id, update);
    this.store.set(optimistic.id, optimistic);

    return () => {
      // Rollback
      if (original) {
        this.store.set(optimistic.id, original);
      } else {
        this.store.delete(optimistic.id);
      }
      this.pending.delete(optimistic.id);
    };
  }

  confirm(id: string): void {
    const update = this.pending.get(id);
    if (update) { update.status = "confirmed"; this.pending.delete(id); }
  }

  get pendingCount(): number { return this.pending.size; }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. SYNC WATERMARK / CHECKPOINT
// ─────────────────────────────────────────────────────────────────────────────

interface SyncCheckpoint {
  collectionName: string;
  lastSyncedAt: ISO8601;
  lastSequence: number;
}

class SyncCheckpointStore {
  private checkpoints = new Map<string, SyncCheckpoint>();

  get(collection: string): SyncCheckpoint {
    return this.checkpoints.get(collection) ?? {
      collectionName: collection,
      lastSyncedAt: new Date(0).toISOString(),
      lastSequence: 0,
    };
  }

  update(collection: string, sequence: number): void {
    this.checkpoints.set(collection, {
      collectionName: collection,
      lastSyncedAt: now(),
      lastSequence: sequence,
    });
  }

  getAll(): SyncCheckpoint[] { return [...this.checkpoints.values()]; }
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. RESPONSE CACHE WITH TTL
// ─────────────────────────────────────────────────────────────────────────────

interface CachedResponse {
  cacheKey: string;
  prompt: string;
  response: string;
  model: string;
  temperature: number;
  createdAt: ISO8601;
  expiresAt: ISO8601;
  hitCount: number;
}

class ResponseCache {
  private cache = new Map<string, CachedResponse>();

  private buildKey(prompt: string, model: string, temperature: number): string {
    const content = `${model}:${temperature}:${prompt}`;
    let hash = 5381;
    for (let i = 0; i < content.length; i++) {
      hash = ((hash << 5) + hash) + content.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash).toString(36);
  }

  get(prompt: string, model: string, temperature: number): CachedResponse | null {
    const key = this.buildKey(prompt, model, temperature);
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (new Date(entry.expiresAt) < new Date()) {
      this.cache.delete(key);
      return null;
    }
    entry.hitCount++;
    return entry;
  }

  set(params: { prompt: string; model: string; temperature: number; response: string }, ttlMs = 3600000): void {
    const key = this.buildKey(params.prompt, params.model, params.temperature);
    this.cache.set(key, {
      cacheKey: key,
      prompt: params.prompt,
      response: params.response,
      model: params.model,
      temperature: params.temperature,
      createdAt: now(),
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
      hitCount: 0,
    });
  }

  purgeExpired(): number {
    let count = 0;
    const currentTime = new Date();
    for (const [key, entry] of this.cache) {
      if (new Date(entry.expiresAt) < currentTime) {
        this.cache.delete(key);
        count++;
      }
    }
    return count;
  }

  get size(): number { return this.cache.size; }
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. EMBEDDING STORE WITH COSINE SIMILARITY
// ─────────────────────────────────────────────────────────────────────────────

interface Embedding {
  id: string;
  documentId: string;
  content: string;
  vector: number[];
  model: string;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

class EmbeddingStore {
  private embeddings: Embedding[] = [];

  add(embedding: Embedding): void {
    this.embeddings.push(embedding);
  }

  similaritySearch(
    queryVector: number[],
    topK = 5,
    threshold = 0.7,
  ): Array<Embedding & { similarity: number }> {
    return this.embeddings
      .map(e => ({ ...e, similarity: cosineSimilarity(queryVector, e.vector) }))
      .filter(e => e.similarity >= threshold)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topK);
  }

  findByDocument(documentId: string): Embedding[] {
    return this.embeddings.filter(e => e.documentId === documentId);
  }

  get size(): number { return this.embeddings.length; }
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. MIGRATION SYSTEM
// ─────────────────────────────────────────────────────────────────────────────

interface MigrationDef {
  version: number;
  name: string;
  description: string;
  up: () => Promise<void>;
  down?: () => Promise<void>;
}

class MigrationRunner {
  private currentVersion = 0;
  private applied: number[] = [];

  async run(migrations: MigrationDef[], targetVersion?: number): Promise<void> {
    const maxVer = migrations.reduce((m, x) => Math.max(m, x.version), 0);
    const target = targetVersion ?? maxVer;
    const pending = migrations
      .filter(m => m.version > this.currentVersion && m.version <= target)
      .sort((a, b) => a.version - b.version);

    for (const migration of pending) {
      console.log(`  Running migration v${migration.version}: ${migration.name}`);
      await migration.up();
      this.currentVersion = migration.version;
      this.applied.push(migration.version);
    }
  }

  getStatus(): { currentVersion: number; applied: number[] } {
    return { currentVersion: this.currentVersion, applied: [...this.applied] };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. SYNC MANAGER (PouchDB-like pattern)
// ─────────────────────────────────────────────────────────────────────────────

type SyncStatus = "idle" | "syncing" | "error" | "offline";
type SyncDirection = "push" | "pull";

interface SyncEvent<T> {
  direction: SyncDirection;
  entity: T;
  action: "create" | "update" | "delete";
}

class SyncManager<T extends BaseEntity> {
  private status: SyncStatus = "idle";
  private localRepo: InMemoryRepository<T>;
  private remoteRepo: InMemoryRepository<T>;
  private history: SyncEvent<T>[] = [];
  private listeners: Array<(status: SyncStatus) => void> = [];

  constructor(local: InMemoryRepository<T>, remote: InMemoryRepository<T>) {
    this.localRepo = local;
    this.remoteRepo = remote;
  }

  onStatusChange(listener: (status: SyncStatus) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  private setStatus(newStatus: SyncStatus): void {
    this.status = newStatus;
    this.listeners.forEach(l => l(newStatus));
  }

  async push(entity: T): Promise<void> {
    this.setStatus("syncing");
    try {
      await this.remoteRepo.upsert(entity);
      this.history.push({ direction: "push", entity, action: "update" });
      this.setStatus("idle");
    } catch {
      this.setStatus("error");
    }
  }

  async pull(id: string): Promise<T | null> {
    this.setStatus("syncing");
    try {
      const entity = await this.remoteRepo.findById(id);
      if (entity) {
        await this.localRepo.upsert(entity);
        this.history.push({ direction: "pull", entity, action: "update" });
      }
      this.setStatus("idle");
      return entity;
    } catch {
      this.setStatus("error");
      return null;
    }
  }

  getStatus(): SyncStatus { return this.status; }
  getHistory(): SyncEvent<T>[] { return [...this.history]; }
}

// ─────────────────────────────────────────────────────────────────────────────
// DEMO / RUN
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n══════════════════════════════════════");
  console.log(" Bài 3: Local-First Data Layer");
  console.log("══════════════════════════════════════\n");

  // ── Repository CRUD ──
  const noteRepo = new OptimisticStore<Note>();

  const n1 = await noteRepo.create({ title: "Meeting Notes", body: "Discuss roadmap", tags: ["work"], authorId: "usr_1" });
  const n2 = await noteRepo.create({ title: "Shopping List",  body: "Apples, Milk",   tags: ["personal"], authorId: "usr_1" });
  console.log("[Created notes]:", n1.id, n2.id);

  const updated = await noteRepo.update(n1.id, { title: "Q4 Meeting Notes", tags: ["work", "q4"] });
  console.log("[Updated]:", updated.title, "| version:", updated.version);

  const results = await noteRepo.findMany({
    where: { authorId: "usr_1", deletedAt: null },
    orderBy: { field: "createdAt", dir: "asc" },
  });
  console.log("[FindMany] count:", results.length, "titles:", results.map(n => n.title));

  // ── Optimistic Update ──
  console.log("\n[Optimistic Updates]");
  const optimisticNote: Note = { ...n2, title: "OPTIMISTIC TITLE", version: n2.version + 1, updatedAt: now() };
  const rollback = noteRepo.applyOptimistic(optimisticNote);
  const afterOpt = await noteRepo.findById(n2.id);
  console.log(`  After optimistic apply: "${afterOpt?.title}"`);

  // Simulate network failure → rollback
  rollback();
  const afterRollback = await noteRepo.findById(n2.id);
  console.log(`  After rollback:         "${afterRollback?.title}"`);

  // Soft delete
  await noteRepo.softDelete(n1.id);
  const withDeleted = await noteRepo.findMany({ includeDeleted: true });
  const withoutDeleted = await noteRepo.findMany({ includeDeleted: false });
  console.log(`\n[Soft delete] total=${withDeleted.length} active=${withoutDeleted.length}`);

  // ── Sync Checkpoints ──
  console.log("\n[Sync Checkpoints]");
  const checkpointStore = new SyncCheckpointStore();
  checkpointStore.update("notes", 42);
  checkpointStore.update("tags",  10);
  checkpointStore.getAll().forEach(cp => {
    console.log(`  ${cp.collectionName}: seq=${cp.lastSequence} at=${cp.lastSyncedAt}`);
  });

  // ── Response Cache ──
  console.log("\n[Response Cache]");
  const cache = new ResponseCache();
  cache.set({ prompt: "Hello!", model: "gpt-4", temperature: 0.7, response: "Hi there!" });
  cache.set({ prompt: "Explain CRDTs", model: "gpt-4", temperature: 0.7, response: "CRDTs are..." });
  const hit = cache.get("Hello!", "gpt-4", 0.7);
  const miss = cache.get("Unknown prompt", "gpt-4", 0.7);
  console.log(`  Cache hit: "${hit?.response}" (hitCount=${hit?.hitCount})`);
  console.log(`  Cache miss: ${miss}`);
  console.log(`  Cache size: ${cache.size}`);

  // ── Embedding Store ──
  console.log("\n[Embedding Store — Cosine Similarity]");
  const embeddingStore = new EmbeddingStore();
  embeddingStore.add({ id: "e1", documentId: "doc1", content: "TypeScript is great", vector: [1, 0, 0, 0.5], model: "text-embedding" });
  embeddingStore.add({ id: "e2", documentId: "doc1", content: "TypeScript generics",  vector: [0.9, 0.1, 0, 0.4], model: "text-embedding" });
  embeddingStore.add({ id: "e3", documentId: "doc2", content: "Cooking recipes",      vector: [0, 0.8, 0.6, 0], model: "text-embedding" });

  const searchResults = embeddingStore.similaritySearch([1, 0, 0, 0.5], 2, 0.5);
  console.log(`  Query: [1,0,0,0.5] → ${searchResults.length} results:`);
  searchResults.forEach(r => {
    console.log(`    "${r.content}" similarity=${r.similarity.toFixed(3)}`);
  });
  console.log(`  Docs for doc1: ${embeddingStore.findByDocument("doc1").length} embeddings`);

  // ── Migration System ──
  console.log("\n[Migration System]");
  const runner = new MigrationRunner();
  const migrations: MigrationDef[] = [
    { version: 1, name: "initial-schema", description: "Create initial tables", up: async () => { console.log("    → Created notes, tags tables"); } },
    { version: 2, name: "add-pinning",    description: "Add isPinned field",    up: async () => { console.log("    → Added isPinned to notes"); } },
    { version: 3, name: "add-branching",  description: "Add parentMessageId",   up: async () => { console.log("    → Added parentMessageId"); } },
  ];
  await runner.run(migrations);
  const migStatus = runner.getStatus();
  console.log(`  Current version: ${migStatus.currentVersion}, applied: [${migStatus.applied.join(", ")}]`);

  // ── Sync Manager ──
  console.log("\n[Sync Manager]");
  const localRepo = new InMemoryRepository<Note>();
  const remoteRepo = new InMemoryRepository<Note>();
  const syncMgr = new SyncManager(localRepo, remoteRepo);

  const statusChanges: SyncStatus[] = [];
  syncMgr.onStatusChange(s => statusChanges.push(s));

  const localNote = await localRepo.create({ title: "Local Note", body: "Written offline", tags: ["draft"], authorId: "usr_1" });
  console.log(`  Created local note: "${localNote.title}"`);

  await syncMgr.push(localNote);
  const remoteCopy = await remoteRepo.findById(localNote.id);
  console.log(`  After push, remote has: "${remoteCopy?.title}"`);

  const pulled = await syncMgr.pull(localNote.id);
  console.log(`  After pull: "${pulled?.title}"`);
  console.log(`  Status transitions: [${statusChanges.join(" → ")}]`);
  console.log(`  Sync history: ${syncMgr.getHistory().length} events`);

  console.log("\n✅ Bài 3 hoàn thành!\n");
}

main().catch(console.error);

export {};

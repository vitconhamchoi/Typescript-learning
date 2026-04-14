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

  console.log("\n✅ Bài 3 hoàn thành!\n");
}

main().catch(console.error);

export {};

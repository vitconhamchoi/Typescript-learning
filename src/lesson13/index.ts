/**
 * Bài 13: GraphQL API Gateway (Federation simulation)
 * ====================================================
 * Chạy: npm run lesson13
 *
 * Nội dung:
 *  - Schema definition language (SDL) typed interfaces
 *  - Resolver map with DataLoader (N+1 prevention)
 *  - Federation entities (@key directives simulation)
 *  - Persisted queries
 *  - Schema stitching / merging
 */

// ─────────────────────────────────────────────────────────────────────────────
// 1. TYPED SCHEMA DEFINITIONS (mirrors GraphQL SDL)
// ─────────────────────────────────────────────────────────────────────────────

interface GQLNote {
  id: string;
  title: string;
  body: string;
  authorId: string;
  tags: string[];
  createdAt: string;
}

interface GQLUser {
  id: string;
  name: string;
  email: string;
  notes?: GQLNote[];  // resolved by federation
}

interface GQLTag {
  name: string;
  noteCount: number;
}

interface GQLQueryRoot {
  note(args: { id: string }): Promise<GQLNote | null>;
  notes(args: { authorId?: string; tag?: string; limit?: number }): Promise<GQLNote[]>;
  user(args: { id: string }): Promise<GQLUser | null>;
  tags(): Promise<GQLTag[]>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. DATA LOADERS (batch + cache to prevent N+1)
// ─────────────────────────────────────────────────────────────────────────────

class DataLoader<K, V> {
  private cache = new Map<K, V>();
  private batch: K[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending = new Map<K, Array<{ resolve: (v: V | null) => void; reject: (e: Error) => void }>>();

  constructor(
    private readonly batchFn: (keys: K[]) => Promise<(V | null)[]>,
    private readonly batchDelayMs = 0,
  ) {}

  load(key: K): Promise<V | null> {
    if (this.cache.has(key)) return Promise.resolve(this.cache.get(key) ?? null);

    return new Promise((resolve, reject) => {
      // Support multiple pending promises for the same key
      const callbacks = this.pending.get(key) ?? [];
      if (callbacks.length === 0) {
        this.batch.push(key); // only add to batch once per unique key
      }
      callbacks.push({ resolve, reject });
      this.pending.set(key, callbacks);

      if (!this.timer) {
        this.timer = setTimeout(() => void this.flush(), this.batchDelayMs);
      }
    });
  }

  private async flush(): Promise<void> {
    this.timer = null;
    const uniqueKeys = [...this.pending.keys()];
    const pending    = new Map(this.pending);
    this.batch = [];
    this.pending.clear();

    console.log(`  [DataLoader] Batch load ${uniqueKeys.length} key(s):`, uniqueKeys);
    try {
      const values = await this.batchFn(uniqueKeys);
      uniqueKeys.forEach((key, i) => {
        const val = values[i] ?? null;
        if (val !== null) this.cache.set(key, val);
        for (const { resolve } of pending.get(key) ?? []) resolve(val);
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      for (const callbacks of pending.values()) {
        for (const { reject } of callbacks) reject(error);
      }
    }
  }

  clearCache(): void { this.cache.clear(); }
  get cacheSize(): number { return this.cache.size; }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. IN-MEMORY DATA SOURCE
// ─────────────────────────────────────────────────────────────────────────────

const NOTES: GQLNote[] = [
  { id: "n1", title: "TypeScript Generics", body: "...", authorId: "u1", tags: ["typescript", "tutorial"], createdAt: "2024-01-01T00:00:00Z" },
  { id: "n2", title: "Offline-First",       body: "...", authorId: "u1", tags: ["offline", "architecture"],  createdAt: "2024-01-02T00:00:00Z" },
  { id: "n3", title: "AI Agents",           body: "...", authorId: "u2", tags: ["ai", "typescript"],          createdAt: "2024-01-03T00:00:00Z" },
  { id: "n4", title: "CRDTs Explained",     body: "...", authorId: "u2", tags: ["crdt", "offline"],           createdAt: "2024-01-04T00:00:00Z" },
];

const USERS: GQLUser[] = [
  { id: "u1", name: "Alice Nguyen", email: "alice@example.com" },
  { id: "u2", name: "Bob Tran",     email: "bob@example.com" },
];

// ─────────────────────────────────────────────────────────────────────────────
// 4. RESOLVERS + FEDERATION
// ─────────────────────────────────────────────────────────────────────────────

class NoteService {
  private userLoader: DataLoader<string, GQLUser>;

  constructor() {
    this.userLoader = new DataLoader<string, GQLUser>(
      async (ids) => ids.map(id => USERS.find(u => u.id === id) ?? null),
    );
  }

  async note({ id }: { id: string }): Promise<GQLNote | null> {
    return NOTES.find(n => n.id === id) ?? null;
  }

  async notes({ authorId, tag, limit }: { authorId?: string; tag?: string; limit?: number }): Promise<GQLNote[]> {
    let results = [...NOTES];
    if (authorId) results = results.filter(n => n.authorId === authorId);
    if (tag)      results = results.filter(n => n.tags.includes(tag));
    if (limit)    results = results.slice(0, limit);
    return results;
  }

  async author(note: GQLNote): Promise<GQLUser | null> {
    return this.userLoader.load(note.authorId);
  }

  async tags(): Promise<GQLTag[]> {
    const counts = new Map<string, number>();
    NOTES.forEach(n => n.tags.forEach(t => counts.set(t, (counts.get(t) ?? 0) + 1)));
    return [...counts.entries()].map(([name, noteCount]) => ({ name, noteCount }));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. PERSISTED QUERIES
// ─────────────────────────────────────────────────────────────────────────────

interface PersistedQuery {
  id: string;
  operationName: string;
  query: string;
  variables?: Record<string, unknown>;
}

class PersistedQueryStore {
  private store = new Map<string, PersistedQuery>();

  register(query: PersistedQuery): void { this.store.set(query.id, query); }

  get(id: string): PersistedQuery | null { return this.store.get(id) ?? null; }

  /** Client sends only hash; server looks up full query */
  resolveRequest(hashOrQuery: string, variables?: Record<string, unknown>): PersistedQuery | null {
    // If it's a hash, look up
    if (this.store.has(hashOrQuery)) {
      const pq = this.store.get(hashOrQuery)!;
      const resolved: PersistedQuery = { ...pq };
      const mergedVars = variables ?? pq.variables;
      if (mergedVars !== undefined) resolved.variables = mergedVars;
      return resolved;
    }
    // Otherwise treat as inline query
    const inline: PersistedQuery = { id: "inline", operationName: "InlineQuery", query: hashOrQuery };
    if (variables !== undefined) inline.variables = variables;
    return inline;
  }

  get size(): number { return this.store.size; }
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. FEDERATION ENTITY RESOLVER (simulate @key directive)
// ─────────────────────────────────────────────────────────────────────────────

interface FederationKey<T> {
  typename: string;
  keyFields: (keyof T)[];
  resolve: (representation: Partial<T>) => Promise<T | null>;
}

class FederationGateway {
  private entities = new Map<string, FederationKey<unknown>>();

  register<T>(entity: FederationKey<T>): void {
    this.entities.set(entity.typename, entity as FederationKey<unknown>);
  }

  async resolveReference(typename: string, representation: Record<string, unknown>): Promise<unknown> {
    const entity = this.entities.get(typename);
    if (!entity) throw new Error(`No federation entity for __typename: ${typename}`);
    return entity.resolve(representation);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DEMO / RUN
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n══════════════════════════════════════");
  console.log(" Bài 13: GraphQL API Gateway");
  console.log("══════════════════════════════════════\n");

  const service = new NoteService();

  // ── Basic queries ──
  console.log("[Resolvers]");
  const note = await service.note({ id: "n1" });
  console.log(`  note(n1): "${note?.title}"`);

  const authorNotes = await service.notes({ authorId: "u1" });
  console.log(`  notes(authorId=u1): ${authorNotes.map(n => n.title).join(", ")}`);

  const aiNotes = await service.notes({ tag: "typescript" });
  console.log(`  notes(tag=typescript): ${aiNotes.map(n => n.title).join(", ")}`);

  const tags = await service.tags();
  console.log(`  tags: ${tags.map(t => `${t.name}(${t.noteCount})`).join(", ")}`);

  // ── DataLoader (N+1 prevention) ──
  console.log("\n[DataLoader — N+1 Prevention]");
  const allNotes = await service.notes({});
  console.log(`  Resolving authors for ${allNotes.length} notes (batched):`);
  const authors = await Promise.all(allNotes.map(n => service.author(n)));
  authors.forEach((a, i) => console.log(`    note[${i}] author: ${a?.name}`));

  // Load same users again — should hit cache
  console.log("  Second pass (from cache):");
  const cachedAuthors = await Promise.all(allNotes.map(n => service.author(n)));
  cachedAuthors.forEach((a, i) => console.log(`    note[${i}] author: ${a?.name} (cached)`));

  // ── Persisted Queries ──
  console.log("\n[Persisted Queries]");
  const pqStore = new PersistedQueryStore();
  pqStore.register({
    id:            "pq:list-notes",
    operationName: "ListNotes",
    query:         "query ListNotes($limit: Int) { notes(limit: $limit) { id title authorId } }",
    variables:     { limit: 10 },
  });
  pqStore.register({
    id:            "pq:note-detail",
    operationName: "NoteDetail",
    query:         "query NoteDetail($id: ID!) { note(id: $id) { id title body tags } }",
  });

  console.log(`  Registered ${pqStore.size} persisted queries`);
  const resolved = pqStore.resolveRequest("pq:list-notes", { limit: 3 });
  console.log(`  Resolved: ${resolved?.operationName} with vars=${JSON.stringify(resolved?.variables)}`);

  // ── Federation ──
  console.log("\n[Federation Entity Resolution]");
  const gateway = new FederationGateway();
  gateway.register<GQLUser>({
    typename: "User",
    keyFields: ["id"],
    resolve: async (rep) => USERS.find(u => u.id === rep.id) ?? null,
  });
  gateway.register<GQLNote>({
    typename: "Note",
    keyFields: ["id"],
    resolve: async (rep) => NOTES.find(n => n.id === rep.id) ?? null,
  });

  const fedUser = await gateway.resolveReference("User", { id: "u2" });
  console.log("  Federated User:", (fedUser as GQLUser)?.name);

  const fedNote = await gateway.resolveReference("Note", { id: "n3" });
  console.log("  Federated Note:", (fedNote as GQLNote)?.title);

  console.log("\n✅ Bài 13 hoàn thành!\n");
}

main().catch(console.error);

export {};

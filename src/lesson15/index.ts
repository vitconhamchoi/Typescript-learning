/**
 * Bài 15: Vector Databases & Semantic Search
 * ============================================
 * Chạy: npm run lesson15
 *
 * Nội dung:
 *  - Typed vector DB abstraction
 *  - Cosine similarity & dot product
 *  - In-memory HNSW-like index (brute force for demo)
 *  - BM25 lexical search
 *  - Hybrid search with Reciprocal Rank Fusion (RRF)
 *  - Namespace / multi-tenant partitioning
 */

// ─────────────────────────────────────────────────────────────────────────────
// 1. VECTOR TYPES & SIMILARITY
// ─────────────────────────────────────────────────────────────────────────────

type Vector = readonly number[];

function dotProduct(a: Vector, b: Vector): number {
  if (a.length !== b.length) throw new Error("Vector dimension mismatch");
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}

function magnitude(v: Vector): number {
  return Math.sqrt(dotProduct(v, v));
}

function cosineSimilarity(a: Vector, b: Vector): number {
  const mag = magnitude(a) * magnitude(b);
  if (mag === 0) return 0;
  return dotProduct(a, b) / mag;
}

function euclideanDistance(a: Vector, b: Vector): number {
  return Math.sqrt(a.reduce((sum, ai, i) => sum + (ai - b[i]!) ** 2, 0));
}

function normalizeVector(v: Vector): Vector {
  const mag = magnitude(v);
  if (mag === 0) return v;
  return v.map(x => x / mag);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. TYPED VECTOR STORE (abstract interface)
// ─────────────────────────────────────────────────────────────────────────────

interface VectorMetadata {
  text: string;
  source?: string;
  chunkIndex?: number;
  documentId?: string;
  [key: string]: unknown;
}

interface VectorDocument {
  id: string;
  vector: Vector;
  metadata: VectorMetadata;
  namespace?: string;
}

interface SearchResult {
  id: string;
  score: number;
  metadata: VectorMetadata;
  vector?: Vector;
}

interface SearchOptions {
  topK?: number;
  namespace?: string;
  filter?: Partial<VectorMetadata>;
  includeVectors?: boolean;
  minScore?: number;
}

interface VectorStore {
  upsert(docs: VectorDocument[]): Promise<void>;
  query(vector: Vector, opts?: SearchOptions): Promise<SearchResult[]>;
  delete(ids: string[], namespace?: string): Promise<void>;
  fetch(ids: string[], namespace?: string): Promise<VectorDocument[]>;
  stats(): Promise<{ totalVectors: number; namespaces: string[] }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. IN-MEMORY VECTOR STORE (mirrors Pinecone / Weaviate API)
// ─────────────────────────────────────────────────────────────────────────────

class InMemoryVectorStore implements VectorStore {
  private docs = new Map<string, VectorDocument>();

  async upsert(docs: VectorDocument[]): Promise<void> {
    for (const doc of docs) {
      this.docs.set(`${doc.namespace ?? "default"}::${doc.id}`, doc);
    }
    console.log(`  [VectorStore] Upserted ${docs.length} vectors`);
  }

  async query(queryVector: Vector, opts: SearchOptions = {}): Promise<SearchResult[]> {
    const { topK = 5, namespace, filter, includeVectors = false, minScore = -Infinity } = opts;

    const results: SearchResult[] = [];
    for (const doc of this.docs.values()) {
      if (namespace && doc.namespace !== namespace) continue;
      if (filter) {
        const matches = Object.entries(filter).every(([k, v]) => doc.metadata[k] === v);
        if (!matches) continue;
      }
      const score = cosineSimilarity(queryVector, doc.vector);
      if (score < minScore) continue;
      const result: SearchResult = { id: doc.id, score, metadata: doc.metadata };
      if (includeVectors) result.vector = doc.vector;
      results.push(result);
    }

    return results.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  async delete(ids: string[], namespace = "default"): Promise<void> {
    for (const id of ids) this.docs.delete(`${namespace}::${id}`);
  }

  async fetch(ids: string[], namespace = "default"): Promise<VectorDocument[]> {
    return ids.map(id => this.docs.get(`${namespace}::${id}`)).filter(Boolean) as VectorDocument[];
  }

  async stats(): Promise<{ totalVectors: number; namespaces: string[] }> {
    const namespaces = [...new Set([...this.docs.values()].map(d => d.namespace ?? "default"))];
    return { totalVectors: this.docs.size, namespaces };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. BM25 LEXICAL SEARCH
// ─────────────────────────────────────────────────────────────────────────────

interface BM25Document {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
}

class BM25Index {
  private docs: BM25Document[] = [];
  private tf  = new Map<string, Map<string, number>>(); // term → docId → freq
  private df  = new Map<string, number>(); // term → doc count
  private avgDocLen = 0;
  private readonly k1 = 1.5;
  private readonly b  = 0.75;

  private tokenize(text: string): string[] {
    return text.toLowerCase().replace(/[^\w\s]/g, "").split(/\s+/).filter(Boolean);
  }

  add(docs: BM25Document[]): void {
    for (const doc of docs) {
      this.docs.push(doc);
      const tokens = this.tokenize(doc.text);
      const freq   = new Map<string, number>();
      for (const tok of tokens) freq.set(tok, (freq.get(tok) ?? 0) + 1);
      this.tf.set(doc.id, freq);
      for (const tok of freq.keys()) this.df.set(tok, (this.df.get(tok) ?? 0) + 1);
    }
    this.avgDocLen = this.docs.reduce((sum, d) => sum + this.tokenize(d.text).length, 0) / this.docs.length;
  }

  search(query: string, topK = 5): Array<{ id: string; score: number; metadata?: Record<string, unknown> }> {
    const queryTokens = this.tokenize(query);
    const N           = this.docs.length;
    const scores      = new Map<string, number>();

    for (const doc of this.docs) {
      const docLen = this.tokenize(doc.text).length;
      const docFreq = this.tf.get(doc.id) ?? new Map();
      let score = 0;

      for (const term of queryTokens) {
        const tf  = docFreq.get(term) ?? 0;
        const df  = this.df.get(term) ?? 0;
        if (tf === 0 || df === 0) continue;
        const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
        const num = tf * (this.k1 + 1);
        const den = tf + this.k1 * (1 - this.b + this.b * docLen / this.avgDocLen);
        score += idf * (num / den);
      }
      if (score > 0) scores.set(doc.id, score);
    }

    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topK)
      .map(([id, score]) => {
        const result: { id: string; score: number; metadata?: Record<string, unknown> } = { id, score };
        const meta = this.docs.find(d => d.id === id)?.metadata;
        if (meta !== undefined) result.metadata = meta;
        return result;
      });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. HYBRID SEARCH — Reciprocal Rank Fusion (RRF)
// ─────────────────────────────────────────────────────────────────────────────

interface RankedResult {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
}

function reciprocalRankFusion(
  ...resultSets: RankedResult[][]
): RankedResult[] {
  const k = 60; // RRF constant
  const scores = new Map<string, number>();
  const metaMap = new Map<string, Record<string, unknown> | undefined>();

  for (const results of resultSets) {
    results.forEach((r, rank) => {
      scores.set(r.id, (scores.get(r.id) ?? 0) + 1 / (k + rank + 1));
      metaMap.set(r.id, r.metadata);
    });
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, score]) => {
      const result: RankedResult = { id, score };
      const meta = metaMap.get(id);
      if (meta !== undefined) result.metadata = meta;
      return result;
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// DEMO / RUN
// ─────────────────────────────────────────────────────────────────────────────

function mockEmbed(text: string, dims = 8): Vector {
  // Deterministic pseudo-embedding based on text hash
  const seed = text.split("").reduce((h, c) => Math.imul(31, h) + c.charCodeAt(0) | 0, 0);
  return Array.from({ length: dims }, (_, i) => Math.sin(seed * (i + 1) * 0.1));
}

async function main() {
  console.log("\n══════════════════════════════════════");
  console.log(" Bài 15: Vector Databases & Semantic Search");
  console.log("══════════════════════════════════════\n");

  const CORPUS = [
    { id: "d1", text: "TypeScript provides static typing for JavaScript applications" },
    { id: "d2", text: "Offline-first architecture ensures apps work without network connectivity" },
    { id: "d3", text: "CRDTs allow conflict-free data synchronization in distributed systems" },
    { id: "d4", text: "Service workers enable background sync and push notifications" },
    { id: "d5", text: "Vector databases store embeddings for semantic similarity search" },
    { id: "d6", text: "Large language models generate human-like text using transformers" },
    { id: "d7", text: "GraphQL provides a flexible query language for APIs" },
    { id: "d8", text: "gRPC uses protocol buffers for efficient binary serialization" },
  ];

  // ── Vector Math ──
  console.log("[Vector Math]");
  const v1: Vector = [1, 0, 0, 0];
  const v2: Vector = [1, 1, 0, 0];
  const v3: Vector = [0, 0, 1, 0];
  console.log(`  cos(v1, v2) = ${cosineSimilarity(v1, v2).toFixed(4)} (expect 0.7071)`);
  console.log(`  cos(v1, v3) = ${cosineSimilarity(v1, v3).toFixed(4)} (expect 0.0000)`);
  console.log(`  euclidean(v1, v2) = ${euclideanDistance(v1, v2).toFixed(4)}`);

  // ── Vector Store ──
  console.log("\n[In-Memory Vector Store]");
  const store = new InMemoryVectorStore();

  const docs: VectorDocument[] = CORPUS.map(d => ({
    id:        d.id,
    vector:    mockEmbed(d.text),
    metadata:  { text: d.text, source: "course-notes" },
    namespace: "lesson15",
  }));
  await store.upsert(docs);

  const query = "semantic search and embeddings";
  const results = await store.query(mockEmbed(query), { topK: 3, namespace: "lesson15" });
  console.log(`\n  Query: "${query}"`);
  results.forEach((r, i) => console.log(`  [${i + 1}] score=${r.score.toFixed(4)} | ${r.metadata.text}`));

  const statsInfo = await store.stats();
  console.log(`\n  Stats: ${statsInfo.totalVectors} vectors, namespaces: [${statsInfo.namespaces.join(", ")}]`);

  // ── BM25 ──
  console.log("\n[BM25 Lexical Search]");
  const bm25 = new BM25Index();
  bm25.add(CORPUS.map(d => ({ id: d.id, text: d.text })));
  const lexResults = bm25.search("typescript static typing", 3);
  console.log("  Query: 'typescript static typing'");
  lexResults.forEach((r, i) => {
    const text = CORPUS.find(d => d.id === r.id)?.text ?? "";
    console.log(`  [${i + 1}] score=${r.score.toFixed(4)} | ${text.slice(0, 60)}`);
  });

  // ── Hybrid Search (RRF) ──
  console.log("\n[Hybrid Search — RRF]");
  const hybridQuery  = "offline data synchronization";
  const vectorHits   = await store.query(mockEmbed(hybridQuery), { topK: 5, namespace: "lesson15" });
  const lexicalHits  = bm25.search(hybridQuery, 5);

  const hybridResults = reciprocalRankFusion(
    vectorHits.map(r  => ({ id: r.id, score: r.score, metadata: r.metadata })),
    lexicalHits.map(r => ({ id: r.id, score: r.score })),
  );

  console.log(`  Query: "${hybridQuery}"`);
  hybridResults.slice(0, 3).forEach((r, i) => {
    const text = CORPUS.find(d => d.id === r.id)?.text ?? "";
    console.log(`  [${i + 1}] RRF=${r.score.toFixed(4)} | ${text.slice(0, 60)}`);
  });

  // ── Namespace filtering ──
  console.log("\n[Namespace / Multi-tenant]");
  const tenant2docs: VectorDocument[] = [
    { id: "t2_1", vector: mockEmbed("tenant 2 document"), metadata: { text: "Tenant 2 data" }, namespace: "tenant2" },
  ];
  await store.upsert(tenant2docs);
  const tenant1Results = await store.query(mockEmbed("data"), { namespace: "lesson15", topK: 2 });
  const tenant2Results = await store.query(mockEmbed("data"), { namespace: "tenant2", topK: 2 });
  console.log(`  Tenant lesson15: ${tenant1Results.length} results`);
  console.log(`  Tenant tenant2:  ${tenant2Results.length} results`);

  console.log("\n✅ Bài 15 hoàn thành!\n");
}

main().catch(console.error);

export {};

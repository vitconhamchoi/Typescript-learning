# Bài 15: Vector Databases & Semantic Search

## Mục tiêu bài học

- Hiểu embedding models và cách chọn model phù hợp
- Implement vector search với Pinecone, Weaviate, và Chroma
- Thiết kế chunking strategy cho documents
- Hybrid search: kết hợp vector search và BM25 full-text
- On-device vector search cho offline AI

---

## 15.1 Embedding Models & Vector Fundamentals

```typescript
// Embedding model abstraction
interface EmbeddingModel {
  modelId: string;
  dimensions: number;
  maxInputTokens: number;
  embed(texts: string[]): Promise<EmbeddingResult[]>;
  embedQuery(query: string): Promise<number[]>;
}

interface EmbeddingResult {
  text: string;
  embedding: number[];
  tokenCount: number;
  index: number;
}

// OpenAI Embeddings
class OpenAIEmbeddingModel implements EmbeddingModel {
  modelId = "text-embedding-3-large";
  dimensions = 3072;
  maxInputTokens = 8191;

  constructor(
    private apiKey: string,
    options?: { dimensions?: number }
  ) {
    if (options?.dimensions) {
      this.dimensions = options.dimensions; // text-embedding-3 supports dimension reduction
    }
  }

  async embed(texts: string[]): Promise<EmbeddingResult[]> {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.modelId,
        input: texts,
        dimensions: this.dimensions,
        encoding_format: "float",
      }),
    });

    if (!response.ok) {
      throw new Error(`Embedding API error: ${response.status}`);
    }

    const data = await response.json() as {
      data: Array<{ embedding: number[]; index: number }>;
      usage: { prompt_tokens: number; total_tokens: number };
    };

    return data.data.map((item, i) => ({
      text: texts[i],
      embedding: item.embedding,
      tokenCount: Math.ceil(texts[i].length / 4),
      index: item.index,
    }));
  }

  async embedQuery(query: string): Promise<number[]> {
    const results = await this.embed([query]);
    return results[0].embedding;
  }
}

// Locally running embedding model (Ollama/llamafile)
class LocalEmbeddingModel implements EmbeddingModel {
  modelId = "nomic-embed-text";
  dimensions = 768;
  maxInputTokens = 8192;

  constructor(private baseUrl: string = "http://localhost:11434") {}

  async embed(texts: string[]): Promise<EmbeddingResult[]> {
    const results = await Promise.all(
      texts.map(async (text, index) => {
        const response = await fetch(`${this.baseUrl}/api/embeddings`, {
          method: "POST",
          body: JSON.stringify({ model: this.modelId, prompt: text }),
        });
        const data = await response.json() as { embedding: number[] };
        return {
          text,
          embedding: data.embedding,
          tokenCount: Math.ceil(text.length / 4),
          index,
        };
      })
    );
    return results;
  }

  async embedQuery(query: string): Promise<number[]> {
    const results = await this.embed([query]);
    return results[0].embedding;
  }
}
```

---

## 15.2 Document Chunking Strategies

```typescript
// Chunk types
interface Chunk {
  id: string;
  documentId: string;
  content: string;
  startChar: number;
  endChar: number;
  chunkIndex: number;
  metadata: Record<string, unknown>;
  tokenCount: number;
}

// Recursive character splitter (best for most documents)
class RecursiveCharacterSplitter {
  private separators: string[];

  constructor(
    private options: {
      chunkSize: number;         // Target chunk size in characters
      chunkOverlap: number;      // Overlap between chunks
      separators?: string[];     // Hierarchical separators
    }
  ) {
    this.separators = options.separators ?? [
      "\n\n",  // Paragraphs first
      "\n",    // Then newlines
      ". ",    // Sentences
      "! ",
      "? ",
      "; ",
      ", ",
      " ",     // Words
      "",      // Characters last resort
    ];
  }

  split(text: string): string[] {
    return this.splitText(text, this.separators);
  }

  private splitText(text: string, separators: string[]): string[] {
    const finalChunks: string[] = [];

    // Find best separator
    let separator = separators[separators.length - 1];
    for (const sep of separators) {
      if (sep === "" || text.includes(sep)) {
        separator = sep;
        break;
      }
    }

    const splits = separator ? text.split(separator) : [text];
    const remainingSeparators = separators.slice(separators.indexOf(separator) + 1);

    let currentChunk = "";
    for (const split of splits) {
      const combined = currentChunk
        ? currentChunk + separator + split
        : split;

      if (combined.length <= this.options.chunkSize) {
        currentChunk = combined;
      } else {
        if (currentChunk) {
          finalChunks.push(currentChunk);
          // Overlap: keep tail of current chunk
          const overlap = currentChunk.slice(-this.options.chunkOverlap);
          currentChunk = overlap ? overlap + separator + split : split;
        } else if (split.length > this.options.chunkSize && remainingSeparators.length > 0) {
          // Recursively split large pieces
          const subChunks = this.splitText(split, remainingSeparators);
          finalChunks.push(...subChunks.slice(0, -1));
          currentChunk = subChunks[subChunks.length - 1];
        } else {
          finalChunks.push(split);
          currentChunk = "";
        }
      }
    }

    if (currentChunk) {
      finalChunks.push(currentChunk);
    }

    return finalChunks.filter((c) => c.trim().length > 0);
  }
}

// Semantic chunker using sentence boundaries
class SemanticChunker {
  constructor(
    private embeddingModel: EmbeddingModel,
    private options: {
      bufferSize: number;           // Sentences to look ahead/behind
      breakpointPercentileThreshold: number; // 0-100
    }
  ) {}

  async split(text: string): Promise<string[]> {
    const sentences = this.splitIntoSentences(text);
    if (sentences.length <= 1) return sentences;

    // Create sentence groups (with buffer)
    const groups: string[] = sentences.map((_, i) => {
      const start = Math.max(0, i - this.options.bufferSize);
      const end = Math.min(sentences.length, i + this.options.bufferSize + 1);
      return sentences.slice(start, end).join(" ");
    });

    // Embed all groups
    const embeddings = await this.embeddingModel.embed(groups);

    // Calculate cosine distances between consecutive embeddings
    const distances: number[] = [];
    for (let i = 0; i < embeddings.length - 1; i++) {
      const dist = 1 - this.cosineSimilarity(
        embeddings[i].embedding,
        embeddings[i + 1].embedding
      );
      distances.push(dist);
    }

    // Find breakpoints at high distance points
    const threshold = this.percentile(distances, this.options.breakpointPercentileThreshold);
    const breakpoints = distances.reduce<number[]>((acc, d, i) => {
      if (d > threshold) acc.push(i + 1);
      return acc;
    }, []);

    // Create chunks from breakpoints
    const chunks: string[] = [];
    let start = 0;
    for (const bp of breakpoints) {
      chunks.push(sentences.slice(start, bp).join(" "));
      start = bp;
    }
    chunks.push(sentences.slice(start).join(" "));

    return chunks;
  }

  private splitIntoSentences(text: string): string[] {
    return text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [text];
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  private percentile(arr: number[], p: number): number {
    const sorted = [...arr].sort((a, b) => a - b);
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }
}

// Document processor pipeline
class DocumentProcessor {
  constructor(
    private splitter: RecursiveCharacterSplitter,
    private embeddingModel: EmbeddingModel,
    private vectorStore: VectorStore
  ) {}

  async processDocument(
    documentId: string,
    content: string,
    metadata: Record<string, unknown>
  ): Promise<void> {
    // 1. Split into chunks
    const texts = this.splitter.split(content);
    
    // 2. Create chunk objects
    let charOffset = 0;
    const chunks: Chunk[] = texts.map((text, index) => {
      const startChar = charOffset;
      charOffset += text.length;
      return {
        id: `${documentId}-chunk-${index}`,
        documentId,
        content: text,
        startChar,
        endChar: charOffset,
        chunkIndex: index,
        metadata: { ...metadata, chunkIndex: index, totalChunks: texts.length },
        tokenCount: Math.ceil(text.length / 4),
      };
    });

    // 3. Batch embed (process in batches to respect API limits)
    const BATCH_SIZE = 100;
    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE);
      const embeddings = await this.embeddingModel.embed(batch.map((c) => c.content));

      // 4. Upsert to vector store
      await this.vectorStore.upsert(
        batch.map((chunk, j) => ({
          id: chunk.id,
          embedding: embeddings[j].embedding,
          metadata: {
            documentId: chunk.documentId,
            content: chunk.content,
            chunkIndex: chunk.chunkIndex,
            ...chunk.metadata,
          },
        }))
      );
    }

    console.log(`Processed ${chunks.length} chunks from document ${documentId}`);
  }
}

interface VectorStore {
  upsert(vectors: Array<{
    id: string;
    embedding: number[];
    metadata: Record<string, unknown>;
  }>): Promise<void>;
  
  query(
    embedding: number[],
    options: {
      topK: number;
      filter?: Record<string, unknown>;
      includeMetadata?: boolean;
    }
  ): Promise<VectorQueryResult[]>;

  delete(ids: string[]): Promise<void>;
}

interface VectorQueryResult {
  id: string;
  score: number;
  metadata: Record<string, unknown>;
}
```

---

## 15.3 Pinecone Integration

```typescript
import { Pinecone } from "@pinecone-database/pinecone";

class PineconeVectorStore implements VectorStore {
  private index: ReturnType<Pinecone["Index"]>;

  constructor(
    private client: Pinecone,
    private indexName: string,
    private namespace: string = ""
  ) {
    this.index = client.Index(indexName);
  }

  async upsert(vectors: Array<{
    id: string;
    embedding: number[];
    metadata: Record<string, unknown>;
  }>): Promise<void> {
    const ns = this.index.namespace(this.namespace);
    
    // Pinecone batch upsert (max 100 vectors per request)
    const BATCH_SIZE = 100;
    for (let i = 0; i < vectors.length; i += BATCH_SIZE) {
      const batch = vectors.slice(i, i + BATCH_SIZE);
      await ns.upsert(
        batch.map((v) => ({
          id: v.id,
          values: v.embedding,
          metadata: v.metadata,
        }))
      );
    }
  }

  async query(
    embedding: number[],
    options: {
      topK: number;
      filter?: Record<string, unknown>;
      includeMetadata?: boolean;
    }
  ): Promise<VectorQueryResult[]> {
    const ns = this.index.namespace(this.namespace);
    
    const response = await ns.query({
      vector: embedding,
      topK: options.topK,
      filter: options.filter as Record<string, unknown>,
      includeMetadata: options.includeMetadata ?? true,
    });

    return (response.matches ?? []).map((match) => ({
      id: match.id,
      score: match.score ?? 0,
      metadata: match.metadata as Record<string, unknown>,
    }));
  }

  async delete(ids: string[]): Promise<void> {
    const ns = this.index.namespace(this.namespace);
    await ns.deleteMany(ids);
  }

  async deleteByFilter(filter: Record<string, unknown>): Promise<void> {
    const ns = this.index.namespace(this.namespace);
    await ns.deleteMany({ filter });
  }
}

// Usage
async function setupPinecone() {
  const client = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! });
  
  // Create index if not exists
  const indexes = await client.listIndexes();
  if (!indexes.indexes?.some((idx) => idx.name === "ai-app")) {
    await client.createIndex({
      name: "ai-app",
      dimension: 3072, // text-embedding-3-large
      metric: "cosine",
      spec: {
        serverless: {
          cloud: "aws",
          region: "us-east-1",
        },
      },
    });
    await client.describeIndex("ai-app"); // Wait for ready
  }

  return new PineconeVectorStore(client, "ai-app");
}
```

---

## 15.4 Hybrid Search — Vector + BM25

```typescript
// Hybrid search combines semantic (vector) and lexical (BM25) search
interface SearchResult {
  id: string;
  content: string;
  documentId: string;
  vectorScore: number;
  bm25Score: number;
  hybridScore: number;
  metadata: Record<string, unknown>;
}

class HybridSearchEngine {
  private bm25Index: BM25Index;

  constructor(
    private vectorStore: VectorStore,
    private embeddingModel: EmbeddingModel
  ) {
    this.bm25Index = new BM25Index();
  }

  addDocuments(chunks: Array<{ id: string; content: string; metadata: Record<string, unknown> }>): void {
    this.bm25Index.addDocuments(chunks.map((c) => ({
      id: c.id,
      text: c.content,
    })));
  }

  async search(
    query: string,
    options: {
      topK?: number;
      vectorWeight?: number;  // 0-1 (alpha)
      filter?: Record<string, unknown>;
    } = {}
  ): Promise<SearchResult[]> {
    const { topK = 10, vectorWeight = 0.7, filter } = options;

    // Parallel search
    const [vectorResults, bm25Results] = await Promise.all([
      this.vectorSearch(query, { topK: topK * 2, filter }),
      this.bm25Search(query, topK * 2),
    ]);

    // Reciprocal Rank Fusion (RRF)
    return this.reciprocalRankFusion(vectorResults, bm25Results, topK, vectorWeight);
  }

  private async vectorSearch(
    query: string,
    options: { topK: number; filter?: Record<string, unknown> }
  ): Promise<VectorQueryResult[]> {
    const embedding = await this.embeddingModel.embedQuery(query);
    return this.vectorStore.query(embedding, options);
  }

  private bm25Search(
    query: string,
    topK: number
  ): Array<{ id: string; score: number; metadata: Record<string, unknown> }> {
    return this.bm25Index.search(query, topK);
  }

  private reciprocalRankFusion(
    vectorResults: VectorQueryResult[],
    bm25Results: Array<{ id: string; score: number; metadata: Record<string, unknown> }>,
    topK: number,
    alpha: number = 0.7
  ): SearchResult[] {
    const K = 60; // RRF constant
    const scores = new Map<string, {
      vectorScore: number;
      bm25Score: number;
      metadata: Record<string, unknown>;
    }>();

    // Vector scores
    vectorResults.forEach(({ id, score, metadata }, rank) => {
      scores.set(id, {
        vectorScore: alpha / (K + rank + 1),
        bm25Score: 0,
        metadata,
      });
    });

    // BM25 scores
    bm25Results.forEach(({ id, score, metadata }, rank) => {
      if (scores.has(id)) {
        scores.get(id)!.bm25Score = (1 - alpha) / (K + rank + 1);
      } else {
        scores.set(id, {
          vectorScore: 0,
          bm25Score: (1 - alpha) / (K + rank + 1),
          metadata,
        });
      }
    });

    // Combine and sort
    return Array.from(scores.entries())
      .map(([id, { vectorScore, bm25Score, metadata }]) => ({
        id,
        content: (metadata.content as string) ?? "",
        documentId: (metadata.documentId as string) ?? "",
        vectorScore,
        bm25Score,
        hybridScore: vectorScore + bm25Score,
        metadata,
      }))
      .sort((a, b) => b.hybridScore - a.hybridScore)
      .slice(0, topK);
  }
}

// Simple BM25 implementation
class BM25Index {
  private documents: Map<string, { id: string; terms: string[]; length: number }> = new Map();
  private termFrequencies: Map<string, Map<string, number>> = new Map(); // term -> docId -> freq
  private avgDocLength = 0;
  private k1 = 1.5;
  private b = 0.75;

  addDocuments(docs: Array<{ id: string; text: string }>): void {
    for (const doc of docs) {
      const terms = this.tokenize(doc.text);
      this.documents.set(doc.id, { id: doc.id, terms, length: terms.length });

      for (const term of terms) {
        if (!this.termFrequencies.has(term)) {
          this.termFrequencies.set(term, new Map());
        }
        const freq = this.termFrequencies.get(term)!;
        freq.set(doc.id, (freq.get(doc.id) ?? 0) + 1);
      }
    }

    this.avgDocLength = Array.from(this.documents.values())
      .reduce((s, d) => s + d.length, 0) / this.documents.size;
  }

  search(
    query: string,
    topK: number
  ): Array<{ id: string; score: number; metadata: Record<string, unknown> }> {
    const queryTerms = this.tokenize(query);
    const scores = new Map<string, number>();

    for (const term of queryTerms) {
      const docFreqs = this.termFrequencies.get(term);
      if (!docFreqs) continue;

      const idf = Math.log(
        (this.documents.size - docFreqs.size + 0.5) / (docFreqs.size + 0.5) + 1
      );

      for (const [docId, tf] of docFreqs) {
        const doc = this.documents.get(docId)!;
        const tfNorm =
          (tf * (this.k1 + 1)) /
          (tf + this.k1 * (1 - this.b + this.b * (doc.length / this.avgDocLength)));
        
        scores.set(docId, (scores.get(docId) ?? 0) + idf * tfNorm);
      }
    }

    return Array.from(scores.entries())
      .map(([id, score]) => ({ id, score, metadata: {} }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .filter((t) => t.length > 2);
  }
}
```

---

## 15.5 On-Device Vector Search với Transformers.js

```typescript
// Client-side embedding + vector search (completely offline!)
// Uses WASM-based transformer models

// In browser:
// import { pipeline, FeatureExtractionPipeline } from '@xenova/transformers';

interface TransformersEmbedder {
  embed(text: string): Promise<Float32Array>;
}

class OnDeviceEmbeddingModel implements EmbeddingModel {
  modelId = "Xenova/all-MiniLM-L6-v2";
  dimensions = 384;
  maxInputTokens = 256;

  constructor(private embedder: TransformersEmbedder) {}

  async embed(texts: string[]): Promise<EmbeddingResult[]> {
    return Promise.all(
      texts.map(async (text, index) => {
        const embedding = await this.embedder.embed(text);
        return {
          text,
          embedding: Array.from(embedding),
          tokenCount: Math.ceil(text.length / 4),
          index,
        };
      })
    );
  }

  async embedQuery(query: string): Promise<number[]> {
    const results = await this.embed([query]);
    return results[0].embedding;
  }
}

// In-memory vector store for small datasets (< 10K vectors)
class InMemoryVectorStore implements VectorStore {
  private vectors: Array<{
    id: string;
    embedding: number[];
    metadata: Record<string, unknown>;
  }> = [];

  async upsert(vectors: Array<{
    id: string;
    embedding: number[];
    metadata: Record<string, unknown>;
  }>): Promise<void> {
    for (const vec of vectors) {
      const existing = this.vectors.findIndex((v) => v.id === vec.id);
      if (existing >= 0) {
        this.vectors[existing] = vec;
      } else {
        this.vectors.push(vec);
      }
    }
  }

  async query(
    embedding: number[],
    options: { topK: number; filter?: Record<string, unknown> }
  ): Promise<VectorQueryResult[]> {
    let candidates = this.vectors;

    // Apply metadata filter
    if (options.filter) {
      candidates = candidates.filter((vec) =>
        Object.entries(options.filter!).every(
          ([key, value]) => vec.metadata[key] === value
        )
      );
    }

    return candidates
      .map((vec) => ({
        id: vec.id,
        score: this.cosineSimilarity(embedding, vec.embedding),
        metadata: vec.metadata,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, options.topK);
  }

  async delete(ids: string[]): Promise<void> {
    this.vectors = this.vectors.filter((v) => !ids.includes(v.id));
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  size(): number {
    return this.vectors.length;
  }
}
```

---

## Tóm tắt Bài 15

| Tool | Capacity | Use Case |
|------|----------|---------|
| Pinecone (serverless) | Millions | Production cloud vector search |
| Weaviate | Millions | Multi-modal, self-hosted |
| Chroma | Thousands | Local development |
| InMemory | < 10K | Browser offline search |
| Transformers.js | Any | On-device embedding |

| Chunking Strategy | Best For |
|-------------------|---------|
| Fixed size | Simple documents, code |
| Recursive character | General text |
| Semantic | Long documents, narratives |
| Sentence window | QA systems |

## Bài tập thực hành

1. Implement **Multi-vector retrieval**: embed cả title lẫn content riêng biệt, query against both.
2. Xây dựng **Vector store migration**: move embeddings từ ChromaDB sang Pinecone mà không re-embed.
3. Implement **Approximate Nearest Neighbor với HNSW** từ đầu để hiểu indexing algorithms.

---

*Tiếp theo: [Bài 16 — RAG Implementation](16-rag-implementation.md)*

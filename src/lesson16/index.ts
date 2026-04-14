/**
 * Bài 16: RAG — Retrieval Augmented Generation
 * ==============================================
 * Chạy: npm run lesson16
 *
 * Nội dung:
 *  - Document chunking strategies
 *  - RAG pipeline (retrieve → rank → generate)
 *  - HyDE (Hypothetical Document Embeddings)
 *  - Multi-query retrieval
 *  - Contextual compression
 *  - Citation synthesis
 */

// ─────────────────────────────────────────────────────────────────────────────
// 1. CHUNKING STRATEGIES
// ─────────────────────────────────────────────────────────────────────────────

interface Chunk {
  id: string;
  text: string;
  documentId: string;
  chunkIndex: number;
  metadata: {
    source: string;
    heading?: string;
    pageNumber?: number;
    startChar: number;
    endChar: number;
  };
}

interface ChunkingOptions {
  chunkSize: number;     // characters
  chunkOverlap: number;  // overlap between chunks
  splitOn: "sentence" | "paragraph" | "fixed";
}

class TextChunker {
  chunk(documentId: string, text: string, source: string, opts: ChunkingOptions): Chunk[] {
    const { chunkSize, chunkOverlap, splitOn } = opts;
    const chunks: Chunk[] = [];

    if (splitOn === "fixed") {
      let start = 0;
      let index = 0;
      while (start < text.length) {
        const end = Math.min(start + chunkSize, text.length);
        chunks.push({
          id: `${documentId}_${index}`,
          text: text.slice(start, end),
          documentId,
          chunkIndex: index++,
          metadata: { source, startChar: start, endChar: end },
        });
        start = end - chunkOverlap;
        if (start >= text.length) break;
      }
    } else if (splitOn === "sentence") {
      const sentences = text.match(/[^.!?]+[.!?]+/g) ?? [text];
      let current = "";
      let index = 0;
      let startChar = 0;

      for (const sentence of sentences) {
        if (current.length + sentence.length > chunkSize && current.length > 0) {
          chunks.push({
            id: `${documentId}_${index}`,
            text: current.trim(),
            documentId,
            chunkIndex: index++,
            metadata: { source, startChar, endChar: startChar + current.length },
          });
          startChar += current.length - chunkOverlap;
          current = current.slice(-chunkOverlap);
        }
        current += sentence;
      }
      if (current.trim()) {
        chunks.push({
          id: `${documentId}_${index}`,
          text: current.trim(),
          documentId,
          chunkIndex: index,
          metadata: { source, startChar, endChar: text.length },
        });
      }
    }

    return chunks;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. RETRIEVAL PIPELINE
// ─────────────────────────────────────────────────────────────────────────────

interface RetrievedContext {
  chunk: Chunk;
  score: number;
  rank: number;
}

interface RAGResult {
  answer: string;
  contexts: RetrievedContext[];
  citations: Citation[];
  confidence: number;
  tokensUsed: number;
}

interface Citation {
  number: number;
  text: string;
  source: string;
  chunkId: string;
}

// In-memory vector store (simplified from lesson 15)
type MockVector = string; // we'll use text-as-key for deterministic similarity

class SimpleRAGStore {
  private chunks = new Map<string, Chunk>();

  add(chunks: Chunk[]): void { chunks.forEach(c => this.chunks.set(c.id, c)); }

  retrieve(query: string, topK = 5): RetrievedContext[] {
    // Keyword-based scoring (mock semantic search)
    const queryWords = new Set(query.toLowerCase().split(/\s+/).filter(w => w.length > 3));
    const scored: Array<{ chunk: Chunk; score: number }> = [];

    for (const chunk of this.chunks.values()) {
      const chunkWords = chunk.text.toLowerCase().split(/\s+/);
      const matches = chunkWords.filter(w => queryWords.has(w)).length;
      const score   = matches / Math.max(queryWords.size, 1);
      if (score > 0) scored.push({ chunk, score });
    }

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(({ chunk, score }, rank) => ({ chunk, score, rank: rank + 1 }));
  }

  get size(): number { return this.chunks.size; }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. MOCK LLM (for RAG generation)
// ─────────────────────────────────────────────────────────────────────────────

interface LLMOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

async function mockLLM(prompt: string, opts: LLMOptions = {}): Promise<string> {
  await new Promise(r => setTimeout(r, 20));
  return `[${opts.model ?? "gpt-4o"}] Answer based on context: ${prompt.slice(0, 60)}...`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. HYDE — Hypothetical Document Embeddings
// ─────────────────────────────────────────────────────────────────────────────

async function hydeRetrieval(
  question: string,
  store: SimpleRAGStore,
  topK = 5,
): Promise<RetrievedContext[]> {
  // 1. Generate a hypothetical answer
  const hypoAnswer = await mockLLM(
    `Write a brief answer to this question: ${question}`,
    { temperature: 0 },
  );
  console.log(`  [HyDE] Hypothetical answer: "${hypoAnswer.slice(0, 70)}..."`);

  // 2. Use the hypothetical answer as the retrieval query
  return store.retrieve(hypoAnswer + " " + question, topK);
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. MULTI-QUERY RETRIEVAL
// ─────────────────────────────────────────────────────────────────────────────

async function multiQueryRetrieval(
  question: string,
  store: SimpleRAGStore,
  topK = 5,
): Promise<RetrievedContext[]> {
  // Generate multiple query variations
  const variations = await Promise.all([
    mockLLM(`Rephrase as a keyword search: ${question}`, { temperature: 0.3 }),
    mockLLM(`Rephrase as a technical query: ${question}`, { temperature: 0.3 }),
    mockLLM(`Rephrase in simpler terms: ${question}`, { temperature: 0.3 }),
  ]);

  console.log(`  [MultiQuery] Generated ${variations.length} query variations`);

  // Retrieve for each variation and deduplicate
  const allResults: RetrievedContext[] = [];
  const seenIds = new Set<string>();

  for (const query of [question, ...variations]) {
    const results = store.retrieve(query, topK);
    for (const r of results) {
      if (!seenIds.has(r.chunk.id)) {
        seenIds.add(r.chunk.id);
        allResults.push(r);
      }
    }
  }

  // Re-rank by score and take topK
  return allResults.sort((a, b) => b.score - a.score).slice(0, topK);
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. RAG PIPELINE
// ─────────────────────────────────────────────────────────────────────────────

class RAGPipeline {
  constructor(private readonly store: SimpleRAGStore) {}

  async query(question: string, opts: {
    topK?: number;
    strategy?: "simple" | "hyde" | "multi-query";
    model?: string;
  } = {}): Promise<RAGResult> {
    const { topK = 4, strategy = "simple", model = "gpt-4o" } = opts;

    // 1. Retrieve
    let contexts: RetrievedContext[];
    switch (strategy) {
      case "hyde":        contexts = await hydeRetrieval(question, this.store, topK); break;
      case "multi-query": contexts = await multiQueryRetrieval(question, this.store, topK); break;
      default:            contexts = this.store.retrieve(question, topK);
    }

    // 2. Contextual compression (remove low-relevance sentences)
    const compressedContexts = this.#compressContexts(contexts, question);

    // 3. Build prompt
    const prompt = this.#buildRAGPrompt(question, compressedContexts);

    // 4. Generate answer
    const rawAnswer = await mockLLM(prompt, { model, temperature: 0 });

    // 5. Extract citations
    const citations = compressedContexts.map((ctx, i) => ({
      number:  i + 1,
      text:    ctx.chunk.text.slice(0, 100) + "...",
      source:  ctx.chunk.metadata.source,
      chunkId: ctx.chunk.id,
    }));

    // 6. Attach citation references to answer
    const answer = rawAnswer + "\n\n" + citations.map(c => `[${c.number}] ${c.source}`).join("\n");

    const confidence = compressedContexts.reduce((sum, c) => sum + c.score, 0) / Math.max(compressedContexts.length, 1);

    return {
      answer,
      contexts: compressedContexts,
      citations,
      confidence,
      tokensUsed: Math.ceil(prompt.length / 4) + Math.ceil(answer.length / 4),
    };
  }

  #compressContexts(contexts: RetrievedContext[], query: string): RetrievedContext[] {
    const queryWords = new Set(query.toLowerCase().split(/\s+/).filter(w => w.length > 3));
    return contexts
      .map(ctx => {
        // Extract sentences most relevant to the query
        const sentences = ctx.chunk.text.match(/[^.!?]+[.!?]+/g) ?? [ctx.chunk.text];
        const relevant  = sentences.filter(s =>
          s.toLowerCase().split(/\s+/).some(w => queryWords.has(w)),
        );
        return {
          ...ctx,
          chunk: { ...ctx.chunk, text: relevant.join(" ") || ctx.chunk.text },
        };
      })
      .filter(ctx => ctx.chunk.text.trim().length > 0);
  }

  #buildRAGPrompt(question: string, contexts: RetrievedContext[]): string {
    const contextText = contexts
      .map((c, i) => `[${i + 1}] ${c.chunk.text}`)
      .join("\n\n");

    return [
      "You are a helpful assistant. Answer the question based on the following context.",
      "If the context doesn't contain enough information, say so.",
      "",
      "Context:",
      contextText,
      "",
      `Question: ${question}`,
      "",
      "Answer (cite sources using [1], [2], etc.):",
    ].join("\n");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DEMO / RUN
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n══════════════════════════════════════");
  console.log(" Bài 16: RAG — Retrieval Augmented Generation");
  console.log("══════════════════════════════════════\n");

  // ── Build Knowledge Base ──
  const chunker = new TextChunker();
  const store   = new SimpleRAGStore();

  const documents = [
    {
      id:   "ts-guide",
      text: "TypeScript provides static typing. TypeScript uses type inference. TypeScript generics enable reusable components. TypeScript's type system catches errors at compile time. TypeScript is a superset of JavaScript. Type annotations improve code documentation.",
      src:  "typescript-guide.md",
    },
    {
      id:   "offline-guide",
      text: "Offline-first architecture ensures applications work without network connectivity. Service workers cache resources offline. Background sync queues operations offline. CRDTs enable conflict-free data synchronization. Offline databases include IndexedDB and SQLite. Offline sync strategies include sync queuing and delta sync.",
      src:  "offline-first-guide.md",
    },
    {
      id:   "ai-guide",
      text: "Large language models generate text using transformers. RAG retrieval augmented generation improves accuracy. Vector embeddings represent semantic meaning. Semantic search finds similar documents. AI agents use tools to complete tasks. LLM orchestration chains multiple AI calls.",
      src:  "ai-guide.md",
    },
  ];

  for (const doc of documents) {
    const chunks = chunker.chunk(doc.id, doc.text, doc.src, { chunkSize: 200, chunkOverlap: 30, splitOn: "sentence" });
    store.add(chunks);
    console.log(`Indexed "${doc.src}": ${chunks.length} chunks`);
  }
  console.log(`\nTotal vectors in store: ${store.size}\n`);

  const pipeline = new RAGPipeline(store);

  // ── Simple RAG ──
  console.log("[Simple RAG Query]");
  const r1 = await pipeline.query("How does TypeScript help with type safety?", { strategy: "simple" });
  console.log(`  Answer: "${r1.answer.slice(0, 100)}..."`);
  console.log(`  Contexts retrieved: ${r1.contexts.length}`);
  console.log(`  Confidence: ${r1.confidence.toFixed(3)}`);
  console.log(`  Citations: ${r1.citations.map(c => `[${c.number}] ${c.source}`).join(", ")}`);

  // ── HyDE ──
  console.log("\n[HyDE Retrieval]");
  const r2 = await pipeline.query("What techniques enable offline applications?", { strategy: "hyde" });
  console.log(`  Contexts: ${r2.contexts.length} | Confidence: ${r2.confidence.toFixed(3)}`);
  console.log(`  Top context: "${r2.contexts[0]?.chunk.text.slice(0, 80)}..."`);

  // ── Multi-Query ──
  console.log("\n[Multi-Query Retrieval]");
  const r3 = await pipeline.query("How do AI agents work with semantic search?", { strategy: "multi-query" });
  console.log(`  Unique contexts found: ${r3.contexts.length}`);
  console.log(`  Sources: ${[...new Set(r3.citations.map(c => c.source))].join(", ")}`);

  console.log("\n✅ Bài 16 hoàn thành!\n");
}

main().catch(console.error);

export {};

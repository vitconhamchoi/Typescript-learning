# Bài 16: RAG — Retrieval Augmented Generation

## Mục tiêu bài học

- Thiết kế RAG pipeline end-to-end với TypeScript
- Advanced retrieval: re-ranking, query expansion, multi-hop
- Contextual compression và answer synthesis
- Offline RAG: local models với Ollama
- Evaluation framework cho RAG quality

---

## 16.1 Basic RAG Pipeline

```typescript
// RAG pipeline types
interface RAGQuery {
  text: string;
  conversationHistory?: Array<{ role: string; content: string }>;
  filters?: Record<string, unknown>;
  options?: RAGOptions;
}

interface RAGOptions {
  topK?: number;
  rerankTopK?: number;
  includeSourceDocuments?: boolean;
  maxContextTokens?: number;
  streamResponse?: boolean;
}

interface RAGResult {
  answer: string;
  sources: SourceDocument[];
  confidence: number;
  retrievalLatencyMs: number;
  generationLatencyMs: number;
  tokensUsed: { prompt: number; completion: number };
}

interface SourceDocument {
  id: string;
  content: string;
  documentId: string;
  documentTitle: string;
  chunkIndex: number;
  relevanceScore: number;
  metadata: Record<string, unknown>;
}

// Basic RAG Pipeline
class BasicRAGPipeline {
  constructor(
    private vectorStore: VectorStore,
    private embeddingModel: EmbeddingModel,
    private llm: LLMClient,
    private options: {
      topK: number;
      maxContextTokens: number;
      systemPrompt: string;
    }
  ) {}

  async query(query: RAGQuery): Promise<RAGResult> {
    const retrievalStart = Date.now();

    // Step 1: Embed query
    const queryEmbedding = await this.embeddingModel.embedQuery(query.text);

    // Step 2: Retrieve relevant chunks
    const retrieved = await this.vectorStore.query(queryEmbedding, {
      topK: query.options?.topK ?? this.options.topK,
      filter: query.filters,
      includeMetadata: true,
    });

    const retrievalLatencyMs = Date.now() - retrievalStart;

    // Step 3: Convert to source documents
    const sources: SourceDocument[] = retrieved.map((r) => ({
      id: r.id,
      content: (r.metadata.content as string) ?? "",
      documentId: (r.metadata.documentId as string) ?? "",
      documentTitle: (r.metadata.title as string) ?? "Unknown",
      chunkIndex: (r.metadata.chunkIndex as number) ?? 0,
      relevanceScore: r.score,
      metadata: r.metadata,
    }));

    // Step 4: Build context
    const context = this.buildContext(sources, this.options.maxContextTokens);

    // Step 5: Generate answer
    const generationStart = Date.now();
    const messages = [
      {
        role: "system" as const,
        content: `${this.options.systemPrompt}

Context from knowledge base:
${context}

Answer the user's question based on the provided context. If the answer is not in the context, say so clearly.`,
      },
      ...(query.conversationHistory ?? []).map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
      { role: "user" as const, content: query.text },
    ];

    const response = await this.llm.complete(messages);
    const generationLatencyMs = Date.now() - generationStart;

    return {
      answer: response.content,
      sources: query.options?.includeSourceDocuments !== false ? sources : [],
      confidence: this.calculateConfidence(retrieved),
      retrievalLatencyMs,
      generationLatencyMs,
      tokensUsed: {
        prompt: response.usage.promptTokens,
        completion: response.usage.completionTokens,
      },
    };
  }

  private buildContext(sources: SourceDocument[], maxTokens: number): string {
    const sections: string[] = [];
    let tokenCount = 0;
    const estimateTokens = (text: string) => Math.ceil(text.length / 4);

    for (const source of sources) {
      const section = `[${source.documentTitle}]\n${source.content}`;
      const tokens = estimateTokens(section);
      
      if (tokenCount + tokens > maxTokens) break;
      
      sections.push(section);
      tokenCount += tokens;
    }

    return sections.join("\n\n---\n\n");
  }

  private calculateConfidence(results: VectorQueryResult[]): number {
    if (results.length === 0) return 0;
    return results[0].score; // Top result's similarity score
  }
}
```

---

## 16.2 Advanced RAG — Query Expansion & Re-ranking

```typescript
// Query transformation strategies
class QueryExpander {
  constructor(private llm: LLMClient) {}

  // HyDE: Hypothetical Document Embeddings
  // Generate a hypothetical answer, embed it, search with that embedding
  async hypotheticalDocumentEmbedding(query: string): Promise<string> {
    const response = await this.llm.complete([
      {
        role: "system",
        content: "Generate a detailed, factual paragraph that would directly answer the following question. Write as if this is an expert document excerpt.",
      },
      { role: "user", content: query },
    ]);
    return response.content;
  }

  // Multi-query: Generate alternative formulations
  async multiQuery(query: string, count: number = 3): Promise<string[]> {
    const response = await this.llm.complete([
      {
        role: "system",
        content: `Generate ${count} alternative formulations of the following question. Return as a JSON array of strings. Different angles, synonyms, and sub-questions.`,
      },
      { role: "user", content: query },
    ]);

    try {
      return JSON.parse(response.content) as string[];
    } catch {
      return [query]; // Fallback to original
    }
  }

  // Step-back prompting: More general question for better context
  async stepBack(query: string): Promise<string> {
    const response = await this.llm.complete([
      {
        role: "system",
        content: "Generate a more general, higher-level version of this question that would provide better context.",
      },
      { role: "user", content: query },
    ]);
    return response.content;
  }
}

// Re-ranker using cross-encoder model
class CrossEncoderReranker {
  constructor(
    private llm: LLMClient,
    private topK: number = 5
  ) {}

  async rerank(
    query: string,
    documents: SourceDocument[]
  ): Promise<SourceDocument[]> {
    if (documents.length <= this.topK) return documents;

    // Score each document with the LLM
    const scores = await Promise.all(
      documents.map(async (doc) => {
        const score = await this.scoreRelevance(query, doc.content);
        return { doc, score };
      })
    );

    return scores
      .sort((a, b) => b.score - a.score)
      .slice(0, this.topK)
      .map(({ doc, score }) => ({ ...doc, relevanceScore: score }));
  }

  private async scoreRelevance(query: string, document: string): Promise<number> {
    const response = await this.llm.complete([
      {
        role: "system",
        content: `Rate the relevance of the document to the query on a scale of 0-10. Return ONLY a number.
Query: "${query}"
Document: "${document.slice(0, 500)}"`,
      },
      { role: "user", content: "Relevance score:" },
    ]);

    const score = parseFloat(response.content.trim());
    return isNaN(score) ? 0 : score / 10;
  }
}

// Multi-hop RAG for complex questions
class MultiHopRAG {
  private maxHops = 3;

  constructor(
    private retriever: BasicRAGPipeline,
    private llm: LLMClient,
    private queryExpander: QueryExpander
  ) {}

  async query(question: string): Promise<{
    finalAnswer: string;
    hops: Array<{ query: string; retrieved: SourceDocument[]; intermediateAnswer: string }>;
  }> {
    const hops: Array<{
      query: string;
      retrieved: SourceDocument[];
      intermediateAnswer: string;
    }> = [];

    let currentQuery = question;
    let context = "";

    for (let hop = 0; hop < this.maxHops; hop++) {
      // Retrieve for current query
      const result = await this.retriever.query({
        text: currentQuery,
        options: { topK: 5, includeSourceDocuments: true },
      });

      hops.push({
        query: currentQuery,
        retrieved: result.sources,
        intermediateAnswer: result.answer,
      });

      // Check if answer is complete
      const isComplete = await this.checkCompleteness(question, result.answer);
      if (isComplete) break;

      // Generate follow-up query for next hop
      context += `\n\nRetrieved: ${result.answer}`;
      const followUp = await this.generateFollowUp(question, context);
      if (!followUp || followUp === currentQuery) break;
      currentQuery = followUp;
    }

    // Synthesize final answer from all hops
    const finalAnswer = await this.synthesize(question, hops);

    return { finalAnswer, hops };
  }

  private async checkCompleteness(
    originalQuestion: string,
    answer: string
  ): Promise<boolean> {
    const response = await this.llm.complete([
      {
        role: "system",
        content: `Does this answer fully address the question? Reply with "yes" or "no".
Question: ${originalQuestion}
Answer: ${answer}`,
      },
      { role: "user", content: "" },
    ]);
    return response.content.toLowerCase().includes("yes");
  }

  private async generateFollowUp(question: string, context: string): Promise<string> {
    const response = await this.llm.complete([
      {
        role: "system",
        content: `Given the original question and retrieved context, what additional information is needed?
Generate a specific follow-up search query (or return "DONE" if complete).
Original: ${question}
Retrieved so far: ${context}`,
      },
      { role: "user", content: "" },
    ]);
    
    const content = response.content.trim();
    return content === "DONE" ? "" : content;
  }

  private async synthesize(
    question: string,
    hops: Array<{ query: string; retrieved: SourceDocument[]; intermediateAnswer: string }>
  ): Promise<string> {
    const allContext = hops
      .map((hop, i) => `Step ${i + 1}: ${hop.intermediateAnswer}`)
      .join("\n\n");

    const response = await this.llm.complete([
      {
        role: "system",
        content: `Synthesize a comprehensive answer to the original question using the retrieved information from multiple search steps.`,
      },
      {
        role: "user",
        content: `Question: ${question}\n\nRetrieved information:\n${allContext}`,
      },
    ]);

    return response.content;
  }
}
```

---

## 16.3 Contextual Compression

```typescript
// Remove irrelevant parts of retrieved documents
class ContextualCompressor {
  constructor(private llm: LLMClient) {}

  async compress(
    query: string,
    documents: SourceDocument[],
    options: { minScore?: number; maxLength?: number } = {}
  ): Promise<SourceDocument[]> {
    const { minScore = 0.6, maxLength = 500 } = options;

    const compressed = await Promise.all(
      documents.map((doc) => this.compressDocument(query, doc, maxLength))
    );

    return compressed
      .filter((c) => c.relevanceScore >= minScore)
      .sort((a, b) => b.relevanceScore - a.relevanceScore);
  }

  private async compressDocument(
    query: string,
    document: SourceDocument,
    maxLength: number
  ): Promise<SourceDocument> {
    const response = await this.llm.complete([
      {
        role: "system",
        content: `Extract only the parts of this document that are directly relevant to the query.
If nothing is relevant, return "NOT_RELEVANT".
Query: "${query}"
Document:
${document.content}

Return only the relevant excerpt (max ${maxLength} chars):`,
      },
      { role: "user", content: "" },
    ]);

    const compressed = response.content.trim();
    if (compressed === "NOT_RELEVANT") {
      return { ...document, relevanceScore: 0 };
    }

    return {
      ...document,
      content: compressed,
      relevanceScore: document.relevanceScore * 0.9, // Slightly reduce after compression
    };
  }
}

// Answer synthesis with citations
class AnswerSynthesizer {
  constructor(private llm: LLMClient) {}

  async synthesize(
    query: string,
    sources: SourceDocument[],
    conversationHistory?: Array<{ role: string; content: string }>
  ): Promise<{ answer: string; citations: Citation[] }> {
    const sourceList = sources
      .map((s, i) => `[${i + 1}] ${s.documentTitle}:\n${s.content}`)
      .join("\n\n");

    const response = await this.llm.complete([
      {
        role: "system",
        content: `You are a helpful assistant that answers questions based on provided sources.
Always cite sources using [1], [2], etc. notation.
If information is not in the sources, clearly state that.

Sources:
${sourceList}`,
      },
      ...(conversationHistory ?? []).map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
      { role: "user", content: query },
    ]);

    const citations = this.extractCitations(response.content, sources);
    return { answer: response.content, citations };
  }

  private extractCitations(answer: string, sources: SourceDocument[]): Citation[] {
    const citationPattern = /\[(\d+)\]/g;
    const cited = new Set<number>();
    let match;
    
    while ((match = citationPattern.exec(answer)) !== null) {
      const idx = parseInt(match[1]) - 1;
      if (idx >= 0 && idx < sources.length) {
        cited.add(idx);
      }
    }

    return Array.from(cited).map((idx) => ({
      index: idx + 1,
      documentId: sources[idx].documentId,
      documentTitle: sources[idx].documentTitle,
      relevantExcerpt: sources[idx].content.slice(0, 200),
    }));
  }
}

interface Citation {
  index: number;
  documentId: string;
  documentTitle: string;
  relevantExcerpt: string;
}
```

---

## 16.4 Advanced RAG Pipeline

```typescript
// Complete Advanced RAG with all components
class AdvancedRAGPipeline {
  constructor(
    private vectorStore: VectorStore,
    private embeddingModel: EmbeddingModel,
    private llm: LLMClient,
    private components: {
      queryExpander: QueryExpander;
      reranker: CrossEncoderReranker;
      compressor: ContextualCompressor;
      synthesizer: AnswerSynthesizer;
    }
  ) {}

  async query(input: {
    question: string;
    conversationHistory?: Array<{ role: string; content: string }>;
    useHyDE?: boolean;
    useMultiQuery?: boolean;
    useReranking?: boolean;
    useCompression?: boolean;
    topK?: number;
  }): Promise<{
    answer: string;
    citations: Citation[];
    sources: SourceDocument[];
    metrics: QueryMetrics;
  }> {
    const startTime = Date.now();
    const metrics: QueryMetrics = {
      queryExpansionMs: 0,
      retrievalMs: 0,
      rerankingMs: 0,
      compressionMs: 0,
      generationMs: 0,
      totalMs: 0,
      chunksRetrieved: 0,
      chunksAfterReranking: 0,
      chunksAfterCompression: 0,
    };

    let searchQuery = input.question;

    // Step 1: Query Expansion
    const expansionStart = Date.now();
    if (input.useHyDE) {
      searchQuery = await this.components.queryExpander.hypotheticalDocumentEmbedding(input.question);
    } else if (input.useMultiQuery) {
      const alternativeQueries = await this.components.queryExpander.multiQuery(input.question);
      searchQuery = alternativeQueries.join(" "); // Combine for single search
    }
    metrics.queryExpansionMs = Date.now() - expansionStart;

    // Step 2: Retrieval
    const retrievalStart = Date.now();
    const embedding = await this.embeddingModel.embedQuery(searchQuery);
    const rawResults = await this.vectorStore.query(embedding, {
      topK: (input.topK ?? 10) * 3, // Retrieve more for reranking
      includeMetadata: true,
    });

    const sources: SourceDocument[] = rawResults.map((r) => ({
      id: r.id,
      content: (r.metadata.content as string) ?? "",
      documentId: (r.metadata.documentId as string) ?? "",
      documentTitle: (r.metadata.title as string) ?? "Unknown",
      chunkIndex: (r.metadata.chunkIndex as number) ?? 0,
      relevanceScore: r.score,
      metadata: r.metadata,
    }));
    metrics.retrievalMs = Date.now() - retrievalStart;
    metrics.chunksRetrieved = sources.length;

    // Step 3: Re-ranking
    let finalSources = sources;
    if (input.useReranking) {
      const rerankStart = Date.now();
      finalSources = await this.components.reranker.rerank(input.question, sources);
      metrics.rerankingMs = Date.now() - rerankStart;
    }
    finalSources = finalSources.slice(0, input.topK ?? 5);
    metrics.chunksAfterReranking = finalSources.length;

    // Step 4: Contextual Compression
    if (input.useCompression) {
      const compressionStart = Date.now();
      finalSources = await this.components.compressor.compress(input.question, finalSources);
      metrics.compressionMs = Date.now() - compressionStart;
    }
    metrics.chunksAfterCompression = finalSources.length;

    // Step 5: Answer Synthesis
    const generationStart = Date.now();
    const { answer, citations } = await this.components.synthesizer.synthesize(
      input.question,
      finalSources,
      input.conversationHistory
    );
    metrics.generationMs = Date.now() - generationStart;
    metrics.totalMs = Date.now() - startTime;

    return { answer, citations, sources: finalSources, metrics };
  }
}

interface QueryMetrics {
  queryExpansionMs: number;
  retrievalMs: number;
  rerankingMs: number;
  compressionMs: number;
  generationMs: number;
  totalMs: number;
  chunksRetrieved: number;
  chunksAfterReranking: number;
  chunksAfterCompression: number;
}
```

---

## 16.5 RAG Evaluation Framework

```typescript
// RAG quality metrics
interface RAGEvalResult {
  faithfulness: number;         // Is answer grounded in sources? (0-1)
  answerRelevance: number;      // Does answer address the question? (0-1)
  contextPrecision: number;     // How many retrieved docs are relevant? (0-1)
  contextRecall: number;        // How many relevant docs were retrieved? (0-1)
  overall: number;
}

class RAGEvaluator {
  constructor(private llm: LLMClient) {}

  async evaluate(
    question: string,
    answer: string,
    sources: SourceDocument[],
    groundTruth?: string
  ): Promise<RAGEvalResult> {
    const [faithfulness, answerRelevance, contextPrecision] = await Promise.all([
      this.evaluateFaithfulness(answer, sources),
      this.evaluateAnswerRelevance(question, answer),
      this.evaluateContextPrecision(question, sources),
    ]);

    const contextRecall = groundTruth
      ? await this.evaluateContextRecall(groundTruth, sources)
      : 0;

    return {
      faithfulness,
      answerRelevance,
      contextPrecision,
      contextRecall,
      overall: (faithfulness + answerRelevance + contextPrecision) / 3,
    };
  }

  private async evaluateFaithfulness(
    answer: string,
    sources: SourceDocument[]
  ): Promise<number> {
    const context = sources.map((s) => s.content).join("\n\n");
    const response = await this.llm.complete([
      {
        role: "system",
        content: `Given the context and answer, evaluate if the answer is faithful to (supported by) the context.
Score from 0 (completely fabricated) to 1 (completely grounded in context).
Return ONLY a decimal number.

Context: ${context.slice(0, 2000)}
Answer: ${answer}`,
      },
      { role: "user", content: "Faithfulness score:" },
    ]);

    return parseFloat(response.content.trim()) || 0;
  }

  private async evaluateAnswerRelevance(question: string, answer: string): Promise<number> {
    const response = await this.llm.complete([
      {
        role: "system",
        content: `Rate how well the answer addresses the question (0-1).
Return ONLY a decimal number.
Question: ${question}
Answer: ${answer}`,
      },
      { role: "user", content: "Relevance score:" },
    ]);

    return parseFloat(response.content.trim()) || 0;
  }

  private async evaluateContextPrecision(
    question: string,
    sources: SourceDocument[]
  ): Promise<number> {
    if (sources.length === 0) return 0;
    
    const relevanceChecks = await Promise.all(
      sources.map((source) =>
        this.llm.complete([
          {
            role: "system",
            content: `Is this document relevant to answering the question? Return "1" (yes) or "0" (no).
Question: ${question}
Document: ${source.content.slice(0, 500)}`,
          },
          { role: "user", content: "" },
        ]).then((r) => parseFloat(r.content.trim()) || 0)
      )
    );

    return relevanceChecks.reduce((s, r) => s + r, 0) / relevanceChecks.length;
  }

  private async evaluateContextRecall(
    groundTruth: string,
    sources: SourceDocument[]
  ): Promise<number> {
    const context = sources.map((s) => s.content).join("\n\n");
    const response = await this.llm.complete([
      {
        role: "system",
        content: `What percentage of the ground truth answer is covered by the retrieved context?
Return ONLY a decimal number (0-1).
Ground truth: ${groundTruth}
Retrieved context: ${context.slice(0, 2000)}`,
      },
      { role: "user", content: "" },
    ]);

    return parseFloat(response.content.trim()) || 0;
  }
}

// Offline-capable RAG with local models
class OfflineRAGPipeline {
  constructor(
    private localEmbedding: OnDeviceEmbeddingModel,
    private localVectorStore: InMemoryVectorStore,
    private localLLM: { complete(messages: unknown[]): Promise<{ content: string; usage: { promptTokens: number; completionTokens: number } }> }
  ) {}

  async indexDocuments(documents: Array<{ id: string; content: string; title: string }>): Promise<void> {
    for (const doc of documents) {
      const chunks = this.splitIntoChunks(doc.content, 512);
      const embeddings = await this.localEmbedding.embed(chunks);
      
      await this.localVectorStore.upsert(
        embeddings.map((e, i) => ({
          id: `${doc.id}-${i}`,
          embedding: e.embedding,
          metadata: {
            content: chunks[i],
            documentId: doc.id,
            title: doc.title,
            chunkIndex: i,
          },
        }))
      );
    }
  }

  async query(question: string): Promise<string> {
    const queryEmbedding = await this.localEmbedding.embedQuery(question);
    const results = await this.localVectorStore.query(queryEmbedding, { topK: 5 });
    
    const context = results
      .map((r) => r.metadata.content as string)
      .join("\n\n");

    const response = await this.localLLM.complete([
      {
        role: "system",
        content: `Answer based on: ${context}`,
      },
      { role: "user", content: question },
    ]);

    return response.content;
  }

  private splitIntoChunks(text: string, chunkSize: number): string[] {
    const words = text.split(/\s+/);
    const chunks: string[] = [];
    for (let i = 0; i < words.length; i += chunkSize) {
      chunks.push(words.slice(i, i + chunkSize).join(" "));
    }
    return chunks;
  }
}
```

---

## Tóm tắt Bài 16

| Technique | Giải quyết | Khi nào dùng |
|-----------|-----------|--------------|
| Basic RAG | Simple Q&A | Structured knowledge bases |
| HyDE | Low recall | Abstract questions |
| Multi-query | Query ambiguity | Diverse documents |
| Multi-hop | Complex reasoning | Multi-step questions |
| Re-ranking | Low precision | Cross-encoder available |
| Compression | Context length limit | Long documents |

## Bài tập thực hành

1. Implement **RAG with citations**: highlight exact passages in source documents that support each claim.
2. Xây dựng **Adaptive RAG**: dựa trên query complexity, tự động chọn strategy (simple vs multi-hop).
3. Implement **RAG Cache**: cache embedding + retrieval results cho repeated/similar queries.

---

*Tiếp theo: [Bài 17 — AI Agent Architecture](17-ai-agent-architecture.md)*

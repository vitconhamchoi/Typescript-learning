# Bài 19: Testing AI Systems với TypeScript

## Mục tiêu bài học

- Unit testing cho LLM-based components với mocking
- Integration testing cho RAG pipelines
- LLM Evaluation (LLM-as-judge) pattern
- Property-based testing cho distributed systems
- E2E testing với Playwright cho AI UI

---

## 19.1 Mocking LLM cho Unit Tests

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock LLM client
class MockLLMClient {
  private responses: Map<string, string> = new Map();
  private callHistory: Array<{ messages: unknown[]; response: string }> = [];
  private defaultResponse = '{"type": "final_answer", "thought": "test", "answer": "Test answer", "confidence": 0.9}';

  setResponse(pattern: string | RegExp, response: string): void {
    this.responses.set(String(pattern), response);
  }

  setDefaultResponse(response: string): void {
    this.defaultResponse = response;
  }

  async complete(messages: Array<{ role: string; content: string }>): Promise<{
    content: string;
    usage: { promptTokens: number; completionTokens: number };
  }> {
    const lastUserMessage = messages.filter((m) => m.role === "user").pop()?.content ?? "";
    
    // Find matching response
    let response = this.defaultResponse;
    for (const [pattern, resp] of this.responses) {
      if (lastUserMessage.includes(pattern) || new RegExp(pattern).test(lastUserMessage)) {
        response = resp;
        break;
      }
    }

    this.callHistory.push({ messages, response });

    return {
      content: response,
      usage: {
        promptTokens: messages.reduce((s, m) => s + m.content.length / 4, 0),
        completionTokens: response.length / 4,
      },
    };
  }

  getCallHistory() {
    return [...this.callHistory];
  }

  getCallCount() {
    return this.callHistory.length;
  }

  reset() {
    this.callHistory = [];
    this.responses.clear();
  }

  // Deterministic streaming mock
  async *stream(messages: Array<{ role: string; content: string }>): AsyncIterable<{
    delta: string;
    finish_reason: string | null;
  }> {
    const { content } = await this.complete(messages);
    const words = content.split(" ");
    
    for (let i = 0; i < words.length; i++) {
      yield {
        delta: (i === 0 ? "" : " ") + words[i],
        finish_reason: i === words.length - 1 ? "stop" : null,
      };
    }
  }
}

// Mock vector store
class MockVectorStore implements VectorStore {
  private data: Array<{ id: string; embedding: number[]; metadata: Record<string, unknown> }> = [];

  async upsert(vectors: Array<{ id: string; embedding: number[]; metadata: Record<string, unknown> }>): Promise<void> {
    for (const vec of vectors) {
      const idx = this.data.findIndex((d) => d.id === vec.id);
      if (idx >= 0) {
        this.data[idx] = vec;
      } else {
        this.data.push(vec);
      }
    }
  }

  async query(
    _embedding: number[],
    options: { topK: number; filter?: Record<string, unknown> }
  ): Promise<VectorQueryResult[]> {
    let results = this.data;
    if (options.filter) {
      results = results.filter((d) =>
        Object.entries(options.filter!).every(([k, v]) => d.metadata[k] === v)
      );
    }
    // Return mock results with random scores
    return results.slice(0, options.topK).map((d) => ({
      id: d.id,
      score: 0.85 + Math.random() * 0.1,
      metadata: d.metadata,
    }));
  }

  async delete(ids: string[]): Promise<void> {
    this.data = this.data.filter((d) => !ids.includes(d.id));
  }

  seed(entries: Array<{ id: string; content: string; metadata?: Record<string, unknown> }>): void {
    this.data = entries.map((e) => ({
      id: e.id,
      embedding: Array.from({ length: 384 }, () => Math.random()),
      metadata: { content: e.content, ...e.metadata },
    }));
  }
}

// Mock embedding model
class MockEmbeddingModel implements EmbeddingModel {
  modelId = "mock-model";
  dimensions = 384;
  maxInputTokens = 8192;
  private callCount = 0;

  async embed(texts: string[]): Promise<EmbeddingResult[]> {
    this.callCount += texts.length;
    return texts.map((text, i) => ({
      text,
      embedding: Array.from({ length: this.dimensions }, () => Math.random()),
      tokenCount: Math.ceil(text.length / 4),
      index: i,
    }));
  }

  async embedQuery(query: string): Promise<number[]> {
    const results = await this.embed([query]);
    return results[0].embedding;
  }

  getCallCount() {
    return this.callCount;
  }
}

// ============ TESTS ============

describe("BasicRAGPipeline", () => {
  let mockLLM: MockLLMClient;
  let mockVectorStore: MockVectorStore;
  let mockEmbedding: MockEmbeddingModel;
  let pipeline: BasicRAGPipeline;

  beforeEach(() => {
    mockLLM = new MockLLMClient();
    mockVectorStore = new MockVectorStore();
    mockEmbedding = new MockEmbeddingModel();

    // Seed vector store with test data
    mockVectorStore.seed([
      {
        id: "doc1-chunk1",
        content: "TypeScript was created by Microsoft in 2012.",
        metadata: { documentId: "doc1", title: "TypeScript History" },
      },
      {
        id: "doc1-chunk2",
        content: "TypeScript adds static typing to JavaScript.",
        metadata: { documentId: "doc1", title: "TypeScript History" },
      },
    ]);

    mockLLM.setDefaultResponse("TypeScript was created by Microsoft in 2012 and adds static typing to JavaScript.");

    pipeline = new BasicRAGPipeline(mockVectorStore, mockEmbedding, mockLLM as unknown as LLMClient, {
      topK: 3,
      maxContextTokens: 4000,
      systemPrompt: "You are a helpful assistant.",
    });
  });

  it("should retrieve relevant documents and generate answer", async () => {
    const result = await pipeline.query({ text: "When was TypeScript created?" });

    expect(result.answer).toBeTruthy();
    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.retrievalLatencyMs).toBeGreaterThanOrEqual(0);
    expect(result.generationLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it("should call LLM with context from retrieved documents", async () => {
    await pipeline.query({ text: "What is TypeScript?" });

    const calls = mockLLM.getCallHistory();
    expect(calls.length).toBe(1);
    
    const systemMessage = (calls[0].messages as Array<{ role: string; content: string }>)
      .find((m) => m.role === "system");
    expect(systemMessage?.content).toContain("TypeScript");
  });

  it("should filter by metadata when filter provided", async () => {
    const queryWithFilter: RAGQuery = {
      text: "What is TypeScript?",
      filters: { documentId: "doc1" },
    };
    
    const result = await pipeline.query(queryWithFilter);
    expect(result.sources.every((s) => s.documentId === "doc1")).toBe(true);
  });

  it("should not include sources when includeSourceDocuments is false", async () => {
    const result = await pipeline.query({
      text: "What is TypeScript?",
      options: { includeSourceDocuments: false },
    });
    expect(result.sources).toHaveLength(0);
  });
});
```

---

## 19.2 LLM-as-Judge Evaluation

```typescript
// Evaluate AI outputs using another LLM as judge
interface EvaluationCriteria {
  name: string;
  description: string;
  rubric: Array<{ score: number; description: string }>;
}

interface EvaluationResult {
  criteria: string;
  score: number;           // 0-1
  reasoning: string;
  examples?: string[];
}

class LLMJudge {
  constructor(
    private judgeModel: MockLLMClient,
    private criteriaList: EvaluationCriteria[]
  ) {}

  async evaluate(
    prompt: string,
    response: string,
    criteria?: string[]
  ): Promise<Record<string, EvaluationResult>> {
    const toEvaluate = criteria
      ? this.criteriaList.filter((c) => criteria.includes(c.name))
      : this.criteriaList;

    const results: Record<string, EvaluationResult> = {};

    await Promise.all(
      toEvaluate.map(async (criterion) => {
        const rubricText = criterion.rubric
          .map((r) => `- Score ${r.score}: ${r.description}`)
          .join("\n");

        const judgePrompt = `Evaluate this AI response based on ${criterion.name}.
${criterion.description}

Rubric:
${rubricText}

User Prompt: ${prompt}
AI Response: ${response}

Return JSON: {"score": 0.0-1.0, "reasoning": "...", "examples": ["..."]}`;

        const judgeResponse = await this.judgeModel.complete([
          { role: "system", content: "You are an objective AI evaluator." },
          { role: "user", content: judgePrompt },
        ]);

        try {
          const parsed = JSON.parse(judgeResponse.content) as {
            score: number;
            reasoning: string;
            examples?: string[];
          };
          results[criterion.name] = {
            criteria: criterion.name,
            score: parsed.score,
            reasoning: parsed.reasoning,
            examples: parsed.examples,
          };
        } catch {
          results[criterion.name] = {
            criteria: criterion.name,
            score: 0.5,
            reasoning: "Could not parse evaluation",
          };
        }
      })
    );

    return results;
  }
}

// Standard evaluation criteria for AI chatbots
const STANDARD_CRITERIA: EvaluationCriteria[] = [
  {
    name: "helpfulness",
    description: "Does the response actually help the user achieve their goal?",
    rubric: [
      { score: 1.0, description: "Fully addresses the request with actionable information" },
      { score: 0.7, description: "Partially helpful with some gaps" },
      { score: 0.3, description: "Marginally helpful or off-topic" },
      { score: 0.0, description: "Not helpful or harmful" },
    ],
  },
  {
    name: "accuracy",
    description: "Is the information factually correct?",
    rubric: [
      { score: 1.0, description: "All facts are accurate" },
      { score: 0.7, description: "Mostly accurate with minor errors" },
      { score: 0.3, description: "Contains significant inaccuracies" },
      { score: 0.0, description: "Mostly or completely wrong" },
    ],
  },
  {
    name: "conciseness",
    description: "Is the response appropriately concise without losing necessary detail?",
    rubric: [
      { score: 1.0, description: "Perfect length for the task" },
      { score: 0.7, description: "Slightly verbose or terse" },
      { score: 0.3, description: "Significantly too long or too short" },
      { score: 0.0, description: "Extremely inappropriate length" },
    ],
  },
];

// Test with LLM judge
describe("AI Response Quality with LLM Judge", () => {
  let mockJudge: MockLLMClient;
  let judge: LLMJudge;

  beforeEach(() => {
    mockJudge = new MockLLMClient();
    judge = new LLMJudge(mockJudge, STANDARD_CRITERIA);
  });

  it("should evaluate response helpfulness", async () => {
    mockJudge.setDefaultResponse(
      JSON.stringify({ score: 0.9, reasoning: "Very helpful response" })
    );

    const results = await judge.evaluate(
      "How do I sort an array in TypeScript?",
      "Use array.sort() or array.toSorted() for immutable sort.",
      ["helpfulness"]
    );

    expect(results.helpfulness.score).toBe(0.9);
    expect(results.helpfulness.reasoning).toBe("Very helpful response");
  });
});
```

---

## 19.3 Property-Based Testing

```typescript
import { fc } from "fast-check";

// Property-based tests for distributed sync components
describe("VectorClock Properties", () => {
  it("should maintain causality: if a.tick() then a > a_before", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 20 }),
        (nodeId) => {
          const before = new VectorClock(nodeId);
          const after = before.tick(nodeId);
          expect(VectorClock.compare(after, before)).toBe(1);
        }
      )
    );
  });

  it("should be commutative: merge(a, b) === merge(b, a)", () => {
    fc.assert(
      fc.property(
        fc.record({
          node1: fc.string({ minLength: 1, maxLength: 10 }),
          node2: fc.string({ minLength: 1, maxLength: 10 }),
          ticks1: fc.integer({ min: 0, max: 10 }),
          ticks2: fc.integer({ min: 0, max: 10 }),
        }),
        ({ node1, node2, ticks1, ticks2 }) => {
          let clockA = new VectorClock(node1);
          for (let i = 0; i < ticks1; i++) clockA = clockA.tick(node1);

          let clockB = new VectorClock(node2);
          for (let i = 0; i < ticks2; i++) clockB = clockB.tick(node2);

          const mergedAB = clockA.merge(clockB);
          const mergedBA = clockB.merge(clockA);

          // Merged clocks should be equal
          expect(VectorClock.compare(mergedAB, mergedBA)).toBe(0);
        }
      )
    );
  });

  it("should be idempotent: merge(a, a) === a", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 10 }),
        fc.integer({ min: 0, max: 20 }),
        (nodeId, ticks) => {
          let clock = new VectorClock(nodeId);
          for (let i = 0; i < ticks; i++) clock = clock.tick(nodeId);
          
          const merged = clock.merge(clock);
          expect(VectorClock.compare(merged, clock)).toBe(0);
        }
      )
    );
  });
});

// Property tests for consistent hashing
describe("ConsistentHashRing Properties", () => {
  it("should distribute keys evenly among nodes", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 2, maxLength: 5 }),
        fc.array(fc.string({ minLength: 1, maxLength: 50 }), { minLength: 100, maxLength: 100 }),
        (nodeIds, keys) => {
          const ring = new ConsistentHashRing(150);
          const uniqueNodes = [...new Set(nodeIds)];
          uniqueNodes.forEach((n) => ring.addNode(n));

          const distribution: Record<string, number> = {};
          for (const key of keys) {
            const node = ring.getNode(key);
            if (node) {
              distribution[node] = (distribution[node] ?? 0) + 1;
            }
          }

          // Each node should have at least some keys (with enough virtual nodes)
          if (uniqueNodes.length <= 3) {
            uniqueNodes.forEach((node) => {
              expect(distribution[node] ?? 0).toBeGreaterThan(0);
            });
          }
        }
      )
    );
  });

  it("should always return null for empty ring", () => {
    fc.assert(
      fc.property(
        fc.string(),
        (key) => {
          const ring = new ConsistentHashRing();
          expect(ring.getNode(key)).toBeNull();
        }
      )
    );
  });
});
```

---

## 19.4 Integration Tests for Agent System

```typescript
describe("StructuredReActAgent Integration", () => {
  let mockLLM: MockLLMClient;
  let agent: StructuredReActAgent;
  let callTool: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockLLM = new MockLLMClient();
    callTool = vi.fn().mockResolvedValue({ result: "Tool executed successfully" });

    const testTool: AgentTool = {
      name: "test_tool",
      description: "A test tool",
      schema: z.object({ input: z.string() }),
      execute: callTool,
    };

    const config: AgentConfig = {
      name: "Test Agent",
      description: "Test",
      instructions: "You are a test agent.",
      model: "gpt-4o",
      tools: [testTool],
      memory: {
        shortTerm: new ShortTermMemory(),
        longTerm: new LongTermMemory(),
        workspace: new WorkspaceMemory(),
      },
      maxIterations: 5,
      timeout: 30000,
    };

    agent = new StructuredReActAgent(mockLLM as unknown as {
      complete(messages: Array<{ role: string; content: string }>): Promise<{
        content: string;
        usage: { promptTokens: number; completionTokens: number };
      }>;
    }, config);
  });

  it("should complete task with single tool call", async () => {
    // First call: decide to use tool
    mockLLM.setResponse("task", JSON.stringify({
      type: "tool_call",
      thought: "I need to use the test tool",
      tool: "test_tool",
      input: { input: "test input" },
    }));

    // Second call (after tool result): provide final answer
    mockLLM.setResponse("Tool result", JSON.stringify({
      type: "final_answer",
      thought: "Tool completed successfully",
      answer: "The task is complete",
      confidence: 0.95,
    }));

    const context: Omit<AgentContext, "trace"> = {
      agentId: "test-agent",
      runId: crypto.randomUUID(),
      userId: "test-user",
      memory: {
        shortTerm: new ShortTermMemory(),
        longTerm: new LongTermMemory(),
        workspace: new WorkspaceMemory(),
      },
      config: agent["config"],
      signal: new AbortController().signal,
    };

    const { result, trace } = await agent.run("Complete the task", context);

    expect(result).toBe("The task is complete");
    expect(callTool).toHaveBeenCalledOnce();
    expect(trace.status).toBe("completed");
    expect(trace.steps.length).toBeGreaterThan(0);
    
    const toolCallStep = trace.steps.find((s) => s.type === "tool_call");
    expect(toolCallStep).toBeDefined();
    expect(toolCallStep?.content).toContain("test_tool");
  });

  it("should cancel when signal is aborted", async () => {
    const controller = new AbortController();
    
    // Abort immediately
    controller.abort();

    const context: Omit<AgentContext, "trace"> = {
      agentId: "test-agent",
      runId: crypto.randomUUID(),
      userId: "test-user",
      memory: {
        shortTerm: new ShortTermMemory(),
        longTerm: new LongTermMemory(),
        workspace: new WorkspaceMemory(),
      },
      config: agent["config"],
      signal: controller.signal,
    };

    mockLLM.setDefaultResponse(JSON.stringify({
      type: "thought",
      content: "Thinking...",
    }));

    await expect(agent.run("Complete the task", context)).rejects.toThrow("Agent cancelled");
  });

  it("should stop at max iterations", async () => {
    // Always return tool calls, never final answer
    mockLLM.setDefaultResponse(JSON.stringify({
      type: "tool_call",
      thought: "Need to call tool again",
      tool: "test_tool",
      input: { input: "test" },
    }));

    callTool.mockResolvedValue({ result: "partial result" });

    const context: Omit<AgentContext, "trace"> = {
      agentId: "test-agent",
      runId: crypto.randomUUID(),
      userId: "test-user",
      memory: {
        shortTerm: new ShortTermMemory(),
        longTerm: new LongTermMemory(),
        workspace: new WorkspaceMemory(),
      },
      config: agent["config"],
      signal: new AbortController().signal,
    };

    await expect(agent.run("Infinite task", context)).rejects.toThrow("Max iterations");
  });
});
```

---

## 19.5 E2E Testing Patterns

```typescript
// Snapshot testing for AI outputs
describe("AI Response Consistency", () => {
  it("should provide consistent structure for similar queries", async () => {
    const mockLLM = new MockLLMClient();
    mockLLM.setDefaultResponse("TypeScript is a superset of JavaScript developed by Microsoft.");

    const pipeline = new BasicRAGPipeline(
      new MockVectorStore(),
      new MockEmbeddingModel(),
      mockLLM as unknown as LLMClient,
      {
        topK: 3,
        maxContextTokens: 4000,
        systemPrompt: "You are a helpful assistant.",
      }
    );

    const result = await pipeline.query({ text: "What is TypeScript?" });

    // Structure assertions
    expect(result).toMatchObject({
      answer: expect.any(String),
      sources: expect.any(Array),
      confidence: expect.any(Number),
      retrievalLatencyMs: expect.any(Number),
      generationLatencyMs: expect.any(Number),
      tokensUsed: {
        prompt: expect.any(Number),
        completion: expect.any(Number),
      },
    });

    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });
});

// Test utilities
export function createTestLLM(responses: Record<string, string>): MockLLMClient {
  const llm = new MockLLMClient();
  for (const [pattern, response] of Object.entries(responses)) {
    llm.setResponse(pattern, response);
  }
  return llm;
}

export function createTestContext(
  overrides: Partial<Omit<AgentContext, "trace">> = {}
): Omit<AgentContext, "trace"> {
  return {
    agentId: "test-agent",
    runId: crypto.randomUUID(),
    userId: "test-user",
    memory: {
      shortTerm: new ShortTermMemory(),
      longTerm: new LongTermMemory(),
      workspace: new WorkspaceMemory(),
    },
    config: {
      name: "Test Agent",
      description: "Test",
      instructions: "Test instructions",
      model: "gpt-4o",
      tools: [],
      memory: {
        shortTerm: new ShortTermMemory(),
        longTerm: new LongTermMemory(),
        workspace: new WorkspaceMemory(),
      },
      maxIterations: 5,
      timeout: 30000,
    },
    signal: new AbortController().signal,
    ...overrides,
  };
}
```

---

## Tóm tắt Bài 19

| Test Type | Tool | What to Test |
|-----------|------|-------------|
| Unit | Vitest | Individual functions, mocked LLM |
| Integration | Vitest | Full pipeline với mocks |
| LLM Evaluation | LLM-as-judge | Response quality |
| Property-based | fast-check | Invariants, edge cases |
| E2E | Playwright | User interactions |
| Load | k6 | Latency, throughput |

## Bài tập thực hành

1. Implement **Regression Test Suite**: record LLM responses, replay để detect quality regressions.
2. Xây dựng **Chaos Testing**: randomly inject failures vào circuit breakers, test recovery behavior.
3. Implement **Golden Dataset Evaluation**: run RAG system against curated Q&A pairs, track metrics over time.

---

*Tiếp theo: [Bài 20 — Production Deployment & Monitoring](20-production-deployment-monitoring.md)*

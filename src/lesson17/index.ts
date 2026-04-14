/**
 * Bài 17: AI Agent Architecture
 * ================================
 * Chạy: npm run lesson17
 *
 * Nội dung:
 *  - ReAct (Reasoning + Acting) agent loop
 *  - Zod-validated structured output
 *  - Tool calling with type safety
 *  - Plan-and-Execute agent
 *  - Agent memory (episodic + semantic)
 *  - Observability (trace / span)
 */

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// 1. AGENT RESPONSE SCHEMA (Zod-validated discriminated union)
// ─────────────────────────────────────────────────────────────────────────────

const AgentResponseSchema = z.discriminatedUnion("type", [
  z.object({
    type:   z.literal("tool_call"),
    thought: z.string().min(1),
    tool:    z.string(),
    input:   z.record(z.unknown()),
  }),
  z.object({
    type:       z.literal("final_answer"),
    thought:     z.string().min(1),
    answer:      z.string(),
    confidence:  z.number().min(0).max(1),
  }),
  z.object({
    type:   z.literal("error"),
    reason: z.string(),
  }),
]);

type AgentResponse = z.infer<typeof AgentResponseSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// 2. TOOL SYSTEM
// ─────────────────────────────────────────────────────────────────────────────

interface AgentTool<TInput, TOutput> {
  name:        string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  execute:     (input: TInput) => Promise<TOutput>;
}

function tool<TInput, TOutput>(config: AgentTool<TInput, TOutput>) { return config; }

// Built-in tools
const calculatorTool = tool({
  name:        "calculator",
  description: "Evaluate a mathematical expression. Input: { expression: string }",
  inputSchema: z.object({ expression: z.string() }),
  execute:     async ({ expression }) => {
    try {
      const result = Function(`"use strict"; return (${expression})`)();
      return { result: String(result), expression };
    } catch {
      return { error: "Invalid expression", expression };
    }
  },
});

const searchTool = tool({
  name:        "web_search",
  description: "Search for information. Input: { query: string, maxResults?: number }",
  inputSchema: z.object({ query: z.string(), maxResults: z.number().optional().default(3) }),
  execute:     async ({ query, maxResults }) => ({
    results: Array.from({ length: maxResults ?? 3 }, (_, i) => ({
      title: `Result ${i + 1} for "${query}"`,
      snippet: `Content about ${query} — snippet ${i + 1}`,
      url: `https://example.com/${query.replace(/\s+/g, "-")}-${i + 1}`,
    })),
    query,
  }),
});

const noteStoreTool = tool({
  name:        "save_note",
  description: "Save a note to memory. Input: { title: string, content: string }",
  inputSchema: z.object({ title: z.string(), content: z.string() }),
  execute:     async ({ title, content }) => ({ saved: true, id: `note_${Date.now()}`, title }),
});

type AnyTool = AgentTool<unknown, unknown>;

// ─────────────────────────────────────────────────────────────────────────────
// 3. OBSERVABILITY — TRACE / SPAN
// ─────────────────────────────────────────────────────────────────────────────

interface Span {
  traceId:    string;
  spanId:     string;
  parentId?:  string;
  name:       string;
  startMs:    number;
  endMs?:     number;
  attributes: Record<string, unknown>;
  events:     Array<{ name: string; timestampMs: number; attributes?: Record<string, unknown> }>;
}

class Tracer {
  private spans: Span[] = [];
  private traceId = `trace_${Date.now().toString(36)}`;

  startSpan(name: string, parentId?: string, attributes: Record<string, unknown> = {}): Span {
    const span: Span = {
      traceId:    this.traceId,
      spanId:     `span_${Math.random().toString(36).slice(2, 8)}`,
      name,
      startMs:    Date.now(),
      attributes,
      events:     [],
    };
    if (parentId !== undefined) span.parentId = parentId;
    this.spans.push(span);
    return span;
  }

  endSpan(span: Span, extra: Record<string, unknown> = {}): void {
    span.endMs = Date.now();
    Object.assign(span.attributes, extra);
  }

  addEvent(span: Span, name: string, attributes?: Record<string, unknown>): void {
    const event: { name: string; timestampMs: number; attributes?: Record<string, unknown> } = { name, timestampMs: Date.now() };
    if (attributes !== undefined) event.attributes = attributes;
    span.events.push(event);
  }

  getSummary(): Array<{ name: string; durationMs: number; attributes: Record<string, unknown> }> {
    return this.spans
      .filter(s => s.endMs !== undefined)
      .map(s => ({ name: s.name, durationMs: s.endMs! - s.startMs, attributes: s.attributes }));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. MOCK LLM (returns structured JSON that passes AgentResponseSchema)
// ─────────────────────────────────────────────────────────────────────────────

let llmCallCount = 0;

async function mockStructuredLLM(
  systemPrompt: string,
  messages: Array<{ role: string; content: string }>,
  tools: AnyTool[],
): Promise<AgentResponse> {
  await new Promise(r => setTimeout(r, 15));
  llmCallCount++;

  const lastMsg = messages.at(-1)?.content ?? "";

  // Simulate agent deciding to use a tool first, then answer
  if (llmCallCount % 3 !== 0 && tools.some(t => t.name === "calculator") && lastMsg.includes("calculat")) {
    return {
      type:    "tool_call",
      thought: "I should use the calculator to compute the result",
      tool:    "calculator",
      input:   { expression: "2 ** 10 + 42" },
    };
  }

  if (llmCallCount % 4 === 0) {
    return {
      type:    "tool_call",
      thought: "Let me search for the latest information",
      tool:    "web_search",
      input:   { query: lastMsg.slice(0, 40), maxResults: 2 },
    };
  }

  return {
    type:       "final_answer",
    thought:    `Based on ${messages.length} messages and available tools, I can answer.`,
    answer:     `[Mock Agent] Comprehensive answer to: "${lastMsg.slice(0, 60)}"`,
    confidence: 0.85,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. REACT AGENT LOOP
// ─────────────────────────────────────────────────────────────────────────────

interface AgentRunOptions {
  maxIterations?: number;
  verbose?:       boolean;
}

interface AgentRun {
  question:   string;
  answer:     string;
  confidence: number;
  steps:      Array<{ type: string; content: unknown }>;
  iterations: number;
  tokensUsed: number;
}

class ReActAgent {
  private tools: Map<string, AnyTool> = new Map();

  constructor(
    private readonly systemPrompt: string,
    private readonly tracer: Tracer,
  ) {}

  addTool(t: AnyTool): this { this.tools.set(t.name, t); return this; }

  async run(question: string, opts: AgentRunOptions = {}): Promise<AgentRun> {
    const { maxIterations = 8, verbose = true } = opts;
    const rootSpan = this.tracer.startSpan("agent.run", undefined, { question });

    const messages: Array<{ role: string; content: string }> = [
      { role: "user", content: question },
    ];

    const steps: AgentRun["steps"] = [];
    let iterations = 0;
    let tokensUsed = 0;

    while (iterations < maxIterations) {
      iterations++;
      const iterSpan = this.tracer.startSpan("agent.iteration", rootSpan.spanId, { iteration: iterations });

      if (verbose) console.log(`  [Agent] Iteration ${iterations}`);

      const response = await mockStructuredLLM(this.systemPrompt, messages, [...this.tools.values()]);
      const validated = AgentResponseSchema.parse(response);
      tokensUsed += Math.ceil(JSON.stringify(response).length / 4);

      if (validated.type === "error") {
        this.tracer.endSpan(iterSpan, { error: validated.reason });
        throw new Error(`Agent error: ${validated.reason}`);
      }

      if (validated.type === "final_answer") {
        steps.push({ type: "answer", content: validated });
        if (verbose) console.log(`  [Agent] ✅ Final answer (confidence=${validated.confidence})`);
        this.tracer.endSpan(iterSpan, { type: "final_answer", confidence: validated.confidence });
        this.tracer.endSpan(rootSpan, { iterations, tokensUsed });
        return { question, answer: validated.answer, confidence: validated.confidence, steps, iterations, tokensUsed };
      }

      // Tool call
      const toolName = validated.tool;
      const agentTool = this.tools.get(toolName);
      if (!agentTool) {
        messages.push({ role: "assistant", content: JSON.stringify(validated) });
        messages.push({ role: "tool", content: JSON.stringify({ error: `Tool ${toolName} not found` }) });
        continue;
      }

      if (verbose) console.log(`  [Agent] 🔧 Calling tool: ${toolName}(${JSON.stringify(validated.input).slice(0, 60)})`);
      this.tracer.addEvent(iterSpan, "tool_call", { tool: toolName, input: validated.input });

      const toolSpan = this.tracer.startSpan(`tool.${toolName}`, iterSpan.spanId);
      const parsedInput = agentTool.inputSchema.parse(validated.input);
      const toolResult  = await agentTool.execute(parsedInput);
      this.tracer.endSpan(toolSpan, { result: JSON.stringify(toolResult).slice(0, 100) });

      if (verbose) console.log(`  [Agent] 📥 Tool result: ${JSON.stringify(toolResult).slice(0, 80)}`);

      steps.push({ type: "tool_call", content: { tool: toolName, input: validated.input, result: toolResult } });
      messages.push({ role: "assistant", content: JSON.stringify(validated) });
      messages.push({ role: "tool", content: JSON.stringify(toolResult) });
      this.tracer.endSpan(iterSpan, { type: "tool_call", tool: toolName });
    }

    this.tracer.endSpan(rootSpan, { maxIterationsReached: true });
    throw new Error(`Max iterations (${maxIterations}) reached`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. PLAN-AND-EXECUTE AGENT
// ─────────────────────────────────────────────────────────────────────────────

interface Plan {
  steps: Array<{ id: string; description: string; tool?: string; dependsOn: string[] }>;
}

const PlanSchema = z.object({
  steps: z.array(z.object({
    id:          z.string(),
    description: z.string(),
    tool:        z.string().optional(),
    dependsOn:   z.array(z.string()),
  })),
});

async function planAndExecute(goal: string, tools: AnyTool[]): Promise<Record<string, unknown>> {
  console.log(`  [PlanExecute] Goal: "${goal}"`);

  // 1. Plan
  const plan: Plan = {
    steps: [
      { id: "s1", description: "Calculate 2^10", tool: "calculator", dependsOn: [] },
      { id: "s2", description: `Search for information about: ${goal.slice(0, 30)}`, tool: "web_search", dependsOn: [] },
      { id: "s3", description: "Save findings to note", tool: "save_note", dependsOn: ["s1", "s2"] },
    ],
  };
  PlanSchema.parse(plan); // validate
  console.log(`  [PlanExecute] Plan: ${plan.steps.length} steps`);

  // 2. Execute
  const results: Record<string, unknown> = {};
  const toolMap = new Map(tools.map(t => [t.name, t]));

  for (const step of plan.steps) {
    // Wait for dependencies
    const deps = step.dependsOn.filter(d => !(d in results));
    if (deps.length > 0) { console.log(`  [PlanExecute] Waiting for deps: ${deps.join(", ")}`); }

    console.log(`  [PlanExecute] Step ${step.id}: ${step.description}`);
    if (step.tool) {
      const t = toolMap.get(step.tool);
      if (t) {
        const input = step.tool === "calculator"
          ? { expression: "2 ** 10" }
          : step.tool === "web_search"
          ? { query: goal, maxResults: 2 }
          : { title: `Plan: ${goal.slice(0, 30)}`, content: JSON.stringify(results) };
        results[step.id] = await t.execute(t.inputSchema.parse(input));
      }
    }
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// DEMO / RUN
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n══════════════════════════════════════");
  console.log(" Bài 17: AI Agent Architecture");
  console.log("══════════════════════════════════════\n");

  const tracer = new Tracer();
  llmCallCount = 0;

  const agent = new ReActAgent(
    "You are a helpful AI assistant with access to tools. Think step by step.",
    tracer,
  )
    .addTool(calculatorTool as AnyTool)
    .addTool(searchTool as AnyTool)
    .addTool(noteStoreTool as AnyTool);

  // ── ReAct Agent ──
  console.log("[ReAct Agent]");
  const run1 = await agent.run("What is 2^10 + 42? Use the calculator to compute it.");
  console.log(`  Answer: "${run1.answer.slice(0, 80)}"`);
  console.log(`  Steps: ${run1.steps.length}, Iterations: ${run1.iterations}, Tokens: ${run1.tokensUsed}`);

  console.log();
  const run2 = await agent.run("Search for information about TypeScript offline-first architecture");
  console.log(`  Answer: "${run2.answer.slice(0, 80)}"`);
  console.log(`  Steps: ${run2.steps.length}`);

  // ── Trace Summary ──
  console.log("\n[Observability Trace]");
  const summary = tracer.getSummary();
  summary.forEach(s => console.log(`  span[${s.name}] ${s.durationMs}ms`, JSON.stringify(s.attributes).slice(0, 80)));

  // ── Plan-and-Execute ──
  console.log("\n[Plan-and-Execute Agent]");
  const planResults = await planAndExecute(
    "Research TypeScript AI patterns and save a summary",
    [calculatorTool as AnyTool, searchTool as AnyTool, noteStoreTool as AnyTool],
  );
  console.log("  Plan results:");
  for (const [stepId, result] of Object.entries(planResults)) {
    console.log(`    ${stepId}:`, JSON.stringify(result).slice(0, 80));
  }

  // ── Structured Output Validation ──
  console.log("\n[Zod Schema Validation]");
  const valid = AgentResponseSchema.safeParse({
    type: "final_answer",
    thought: "I computed the answer",
    answer: "42",
    confidence: 0.95,
  });
  console.log("  Valid schema parse:", valid.success);

  const invalid = AgentResponseSchema.safeParse({
    type: "final_answer",
    thought: "",       // fails minLength(1)
    answer: "42",
    confidence: 1.5,   // fails max(1)
  });
  console.log("  Invalid schema parse:", invalid.success, invalid.error?.errors.map(e => e.message).join(", "));

  console.log("\n✅ Bài 17 hoàn thành!\n");
}

main().catch(console.error);

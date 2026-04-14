# Bài 17: AI Agent Architecture với TypeScript

## Mục tiêu bài học

- Thiết kế Agent architecture với planning, memory, và tools
- Implement Plan-and-Execute agent cho complex tasks
- Structured output parsing với Zod
- Agent observability: tracing, logging, metrics
- Self-reflection và self-correction patterns

---

## 17.1 Agent Core Architecture

```typescript
import { z } from "zod";

// Core agent types
interface AgentConfig {
  name: string;
  description: string;
  instructions: string;
  model: string;
  tools: AgentTool[];
  memory: AgentMemory;
  maxIterations: number;
  timeout: number;
}

interface AgentTool {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  execute(input: unknown, context: AgentContext): Promise<unknown>;
}

interface AgentContext {
  agentId: string;
  runId: string;
  userId: string;
  memory: AgentMemory;
  config: AgentConfig;
  trace: AgentTrace;
  signal: AbortSignal;
}

interface AgentMemory {
  shortTerm: ShortTermMemory;
  longTerm: LongTermMemory;
  workspace: WorkspaceMemory;
}

interface AgentTrace {
  runId: string;
  agentName: string;
  steps: AgentStep[];
  startedAt: Date;
  completedAt?: Date;
  totalTokens: number;
  status: "running" | "completed" | "failed" | "cancelled";
}

interface AgentStep {
  id: string;
  type: "thought" | "tool_call" | "tool_result" | "final_answer";
  content: string;
  metadata?: Record<string, unknown>;
  startedAt: Date;
  completedAt?: Date;
  tokensUsed?: number;
}

// Short-term memory (current conversation)
class ShortTermMemory {
  private messages: Array<{ role: string; content: unknown }> = [];

  add(role: string, content: unknown): void {
    this.messages.push({ role, content });
  }

  getMessages(): Array<{ role: string; content: unknown }> {
    return [...this.messages];
  }

  getLastN(n: number): Array<{ role: string; content: unknown }> {
    return this.messages.slice(-n);
  }

  clear(): void {
    this.messages = [];
  }
}

// Long-term memory (persistent facts)
class LongTermMemory {
  private facts: Map<string, { value: unknown; importance: number; addedAt: Date }> = new Map();

  remember(key: string, value: unknown, importance: number = 0.5): void {
    this.facts.set(key, { value, importance, addedAt: new Date() });
  }

  recall(key: string): unknown | undefined {
    return this.facts.get(key)?.value;
  }

  recallAll(): Array<{ key: string; value: unknown; importance: number }> {
    return Array.from(this.facts.entries()).map(([key, { value, importance }]) => ({
      key,
      value,
      importance,
    }));
  }

  getMostImportant(n: number): Array<{ key: string; value: unknown }> {
    return Array.from(this.facts.entries())
      .sort((a, b) => b[1].importance - a[1].importance)
      .slice(0, n)
      .map(([key, { value }]) => ({ key, value }));
  }
}

// Workspace memory (task-specific scratch space)
class WorkspaceMemory {
  private data: Map<string, unknown> = new Map();

  set<T>(key: string, value: T): void {
    this.data.set(key, value);
  }

  get<T>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }

  getAll(): Record<string, unknown> {
    return Object.fromEntries(this.data);
  }

  clear(): void {
    this.data.clear();
  }
}
```

---

## 17.2 Structured Output with Zod

```typescript
// Type-safe tool definitions using Zod
const WebSearchInputSchema = z.object({
  query: z.string().describe("The search query"),
  maxResults: z.number().min(1).max(10).default(5).describe("Number of results"),
  dateRange: z.enum(["day", "week", "month", "year"]).optional().describe("Date filter"),
});

const CodeAnalysisInputSchema = z.object({
  code: z.string().describe("Code to analyze"),
  language: z.enum(["typescript", "python", "javascript", "rust", "go"]),
  analysisType: z.enum(["bugs", "performance", "security", "style"]).array(),
});

const FileOperationInputSchema = z.object({
  operation: z.enum(["read", "write", "delete", "list"]),
  path: z.string(),
  content: z.string().optional(),
});

// Tool factory with Zod schema
function createTypedTool<TInput extends z.ZodTypeAny, TOutput>(config: {
  name: string;
  description: string;
  inputSchema: TInput;
  execute(input: z.infer<TInput>, context: AgentContext): Promise<TOutput>;
}): AgentTool {
  return {
    name: config.name,
    description: config.description,
    schema: config.inputSchema,
    async execute(rawInput: unknown, context: AgentContext): Promise<TOutput> {
      // Validate input with Zod
      const input = config.inputSchema.parse(rawInput) as z.infer<TInput>;
      return config.execute(input, context);
    },
  };
}

// Define tools
const webSearchTool = createTypedTool({
  name: "web_search",
  description: "Search the web for current information",
  inputSchema: WebSearchInputSchema,
  async execute(input, context) {
    console.log(`[Tool] web_search: ${input.query}`);
    // Call actual search API
    return [{ title: "Result 1", url: "https://example.com", snippet: "..." }];
  },
});

const codeAnalysisTool = createTypedTool({
  name: "analyze_code",
  description: "Analyze code for bugs, performance issues, or security vulnerabilities",
  inputSchema: CodeAnalysisInputSchema,
  async execute(input, context) {
    console.log(`[Tool] analyze_code: ${input.language} (${input.analysisType.join(", ")})`);
    return {
      issues: [],
      suggestions: [],
      score: 0.9,
    };
  },
});

// LLM response schema for structured output
const AgentResponseSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("tool_call"),
    thought: z.string().describe("Reasoning about what action to take"),
    tool: z.string().describe("Tool name to call"),
    input: z.record(z.unknown()).describe("Tool input parameters"),
  }),
  z.object({
    type: z.literal("final_answer"),
    thought: z.string().describe("Final reasoning"),
    answer: z.string().describe("Final answer to the user"),
    confidence: z.number().min(0).max(1).describe("Confidence in the answer"),
  }),
]);

type AgentResponse = z.infer<typeof AgentResponseSchema>;
```

---

## 17.3 ReAct Agent with Structured Output

```typescript
class StructuredReActAgent {
  private trace: AgentTrace;

  constructor(
    private llm: {
      complete(messages: Array<{ role: string; content: string }>): Promise<{
        content: string;
        usage: { promptTokens: number; completionTokens: number };
      }>;
    },
    private config: AgentConfig
  ) {
    this.trace = {
      runId: crypto.randomUUID(),
      agentName: config.name,
      steps: [],
      startedAt: new Date(),
      totalTokens: 0,
      status: "running",
    };
  }

  async run(
    task: string,
    context: Omit<AgentContext, "trace">
  ): Promise<{ result: string; trace: AgentTrace }> {
    const fullContext: AgentContext = { ...context, trace: this.trace };
    this.trace.status = "running";

    const toolDescriptions = this.config.tools
      .map((t) => `- ${t.name}: ${t.description}\n  Input: ${JSON.stringify(t.schema._def)}`)
      .join("\n");

    const systemPrompt = `${this.config.instructions}

You are an AI agent with access to the following tools:
${toolDescriptions}

Respond in this JSON format ONLY:
- To call a tool: {"type": "tool_call", "thought": "...", "tool": "...", "input": {...}}
- To give final answer: {"type": "final_answer", "thought": "...", "answer": "...", "confidence": 0.0-1.0}`;

    context.memory.shortTerm.add("system", systemPrompt);
    context.memory.shortTerm.add("user", task);

    try {
      for (let iteration = 0; iteration < this.config.maxIterations; iteration++) {
        if (context.signal.aborted) {
          this.trace.status = "cancelled";
          throw new Error("Agent cancelled");
        }

        const messages = context.memory.shortTerm
          .getMessages()
          .map((m) => ({
            role: m.role as string,
            content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
          }));

        const response = await this.llm.complete(messages);
        this.trace.totalTokens += response.usage.promptTokens + response.usage.completionTokens;

        // Parse structured response
        let parsed: AgentResponse;
        try {
          const json = this.extractJSON(response.content);
          parsed = AgentResponseSchema.parse(json);
        } catch (e) {
          // LLM returned invalid format, ask it to retry
          context.memory.shortTerm.add("assistant", response.content);
          context.memory.shortTerm.add("user", "Please format your response as valid JSON matching the schema.");
          continue;
        }

        if (parsed.type === "final_answer") {
          const step: AgentStep = {
            id: crypto.randomUUID(),
            type: "final_answer",
            content: parsed.answer,
            metadata: { thought: parsed.thought, confidence: parsed.confidence },
            startedAt: new Date(),
            completedAt: new Date(),
          };
          this.trace.steps.push(step);
          this.trace.status = "completed";
          this.trace.completedAt = new Date();

          return { result: parsed.answer, trace: this.trace };
        }

        if (parsed.type === "tool_call") {
          // Record thought
          const thoughtStep: AgentStep = {
            id: crypto.randomUUID(),
            type: "thought",
            content: parsed.thought,
            startedAt: new Date(),
            completedAt: new Date(),
          };
          this.trace.steps.push(thoughtStep);

          // Execute tool
          const tool = this.config.tools.find((t) => t.name === parsed.tool);
          if (!tool) {
            context.memory.shortTerm.add("assistant", JSON.stringify(parsed));
            context.memory.shortTerm.add("user", `Tool "${parsed.tool}" not found. Available: ${this.config.tools.map((t) => t.name).join(", ")}`);
            continue;
          }

          const toolCallStep: AgentStep = {
            id: crypto.randomUUID(),
            type: "tool_call",
            content: `${parsed.tool}(${JSON.stringify(parsed.input)})`,
            metadata: { toolName: parsed.tool, input: parsed.input },
            startedAt: new Date(),
          };
          this.trace.steps.push(toolCallStep);

          let toolResult: unknown;
          try {
            toolResult = await tool.execute(parsed.input, fullContext);
            toolCallStep.completedAt = new Date();
          } catch (error) {
            toolResult = { error: error instanceof Error ? error.message : String(error) };
            toolCallStep.completedAt = new Date();
          }

          const toolResultStep: AgentStep = {
            id: crypto.randomUUID(),
            type: "tool_result",
            content: JSON.stringify(toolResult),
            metadata: { toolName: parsed.tool },
            startedAt: new Date(),
            completedAt: new Date(),
          };
          this.trace.steps.push(toolResultStep);

          // Add to memory
          context.memory.shortTerm.add("assistant", JSON.stringify(parsed));
          context.memory.shortTerm.add("user", `Tool result: ${JSON.stringify(toolResult)}`);
        }
      }

      throw new Error(`Max iterations (${this.config.maxIterations}) reached`);
    } catch (error) {
      this.trace.status = "failed";
      this.trace.completedAt = new Date();
      throw error;
    }
  }

  private extractJSON(text: string): unknown {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON found in response");
    return JSON.parse(match[0]);
  }

  getTrace(): AgentTrace {
    return this.trace;
  }
}
```

---

## 17.4 Plan-and-Execute Agent

```typescript
// Plan schema
const PlanSchema = z.object({
  goal: z.string(),
  steps: z.array(z.object({
    id: z.string(),
    description: z.string(),
    tool: z.string().optional(),
    input: z.record(z.unknown()).optional(),
    dependsOn: z.array(z.string()).default([]),
    output: z.string().optional(), // Variable name to store result
  })),
  expectedOutcome: z.string(),
});

type Plan = z.infer<typeof PlanSchema>;

class PlanAndExecuteAgent {
  constructor(
    private planner: {
      createPlan(task: string, tools: AgentTool[]): Promise<Plan>;
      revisePlan(
        original: Plan,
        completedSteps: string[],
        error: string
      ): Promise<Plan>;
    },
    private executor: StructuredReActAgent,
    private tools: AgentTool[]
  ) {}

  async run(task: string, context: Omit<AgentContext, "trace">): Promise<{
    result: string;
    plan: Plan;
    executionResults: Record<string, unknown>;
  }> {
    // Phase 1: Create plan
    console.log(`[PlanExecute] Creating plan for: ${task}`);
    let plan = await this.planner.createPlan(task, this.tools);
    
    const executionResults: Record<string, unknown> = {};
    const completedSteps: string[] = [];

    // Phase 2: Execute steps (respecting dependencies)
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const remainingSteps = plan.steps.filter(
          (s) => !completedSteps.includes(s.id)
        );

        for (const step of remainingSteps) {
          // Check dependencies
          const depsComplete = step.dependsOn.every((dep) =>
            completedSteps.includes(dep)
          );
          if (!depsComplete) continue;

          console.log(`[PlanExecute] Executing step: ${step.description}`);

          // Substitute variables from previous results
          const input = this.substituteVariables(step.input ?? {}, executionResults);

          let result: unknown;
          if (step.tool) {
            const tool = this.tools.find((t) => t.name === step.tool);
            if (tool) {
              result = await tool.execute(input, context as AgentContext);
            }
          } else {
            // Use executor agent for complex steps
            const { result: agentResult } = await this.executor.run(
              `${step.description}\n\nContext: ${JSON.stringify(executionResults)}`,
              context
            );
            result = agentResult;
          }

          if (step.output) {
            executionResults[step.output] = result;
          }
          completedSteps.push(step.id);
        }

        // All steps complete
        break;
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error(`[PlanExecute] Step failed, revising plan: ${errMsg}`);
        plan = await this.planner.revisePlan(plan, completedSteps, errMsg);
      }
    }

    // Phase 3: Synthesize final result
    const { result } = await this.executor.run(
      `Given these results: ${JSON.stringify(executionResults)}\n\nProvide a comprehensive answer to: ${task}`,
      context
    );

    return { result, plan, executionResults };
  }

  private substituteVariables(
    input: Record<string, unknown>,
    results: Record<string, unknown>
  ): Record<string, unknown> {
    const substitute = (value: unknown): unknown => {
      if (typeof value === "string" && value.startsWith("$")) {
        const varName = value.slice(1);
        return results[varName] ?? value;
      }
      if (typeof value === "object" && value !== null) {
        return Object.fromEntries(
          Object.entries(value).map(([k, v]) => [k, substitute(v)])
        );
      }
      return value;
    };

    return Object.fromEntries(
      Object.entries(input).map(([k, v]) => [k, substitute(v)])
    );
  }
}
```

---

## 17.5 Agent Observability

```typescript
// OpenTelemetry-compatible agent tracing
interface AgentSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  operationName: string;
  startTime: Date;
  endTime?: Date;
  attributes: Record<string, string | number | boolean>;
  events: Array<{ time: Date; name: string; attributes: Record<string, unknown> }>;
  status: "ok" | "error";
  errorMessage?: string;
}

class AgentObservability {
  private spans: AgentSpan[] = [];
  private activeSpans = new Map<string, AgentSpan>();

  startSpan(
    operationName: string,
    attributes: Record<string, string | number | boolean> = {},
    parentSpanId?: string
  ): string {
    const span: AgentSpan = {
      traceId: crypto.randomUUID(),
      spanId: crypto.randomUUID(),
      parentSpanId,
      operationName,
      startTime: new Date(),
      attributes,
      events: [],
      status: "ok",
    };
    this.activeSpans.set(span.spanId, span);
    return span.spanId;
  }

  addEvent(
    spanId: string,
    name: string,
    attributes: Record<string, unknown> = {}
  ): void {
    const span = this.activeSpans.get(spanId);
    if (span) {
      span.events.push({ time: new Date(), name, attributes });
    }
  }

  setAttributes(spanId: string, attributes: Record<string, string | number | boolean>): void {
    const span = this.activeSpans.get(spanId);
    if (span) {
      Object.assign(span.attributes, attributes);
    }
  }

  endSpan(spanId: string, error?: Error): void {
    const span = this.activeSpans.get(spanId);
    if (span) {
      span.endTime = new Date();
      if (error) {
        span.status = "error";
        span.errorMessage = error.message;
      }
      this.spans.push(span);
      this.activeSpans.delete(spanId);
    }
  }

  getMetrics() {
    const completed = this.spans.filter((s) => s.endTime);
    return {
      totalSpans: this.spans.length,
      errorRate: completed.filter((s) => s.status === "error").length / completed.length,
      avgDurationMs:
        completed.reduce((s, span) => {
          const dur = span.endTime!.getTime() - span.startTime.getTime();
          return s + dur;
        }, 0) / completed.length,
      toolCallCount: completed.filter((s) => s.operationName.startsWith("tool:")).length,
    };
  }

  export(): AgentSpan[] {
    return [...this.spans];
  }
}

// Decorator for automatic tracing
function traced(observability: AgentObservability, operationName: string) {
  return function (
    _target: unknown,
    _propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    const original = descriptor.value as (...args: unknown[]) => Promise<unknown>;
    descriptor.value = async function (...args: unknown[]) {
      const spanId = observability.startSpan(operationName);
      try {
        const result = await original.apply(this, args);
        observability.endSpan(spanId);
        return result;
      } catch (error) {
        observability.endSpan(spanId, error as Error);
        throw error;
      }
    };
    return descriptor;
  };
}
```

---

## Tóm tắt Bài 17

| Pattern | Complexity | Best For |
|---------|-----------|---------|
| Basic ReAct | Low | Simple tool use |
| Structured Output | Medium | Reliable parsing |
| Plan-and-Execute | High | Complex multi-step tasks |
| Self-reflection | Medium | Quality improvement |
| Observability | Infrastructure | Production monitoring |

## Bài tập thực hành

1. Implement **Self-reflection loop**: sau khi tạo xong câu trả lời, agent tự critique và cải thiện nó.
2. Xây dựng **Adaptive tool selection**: agent tự học công cụ nào hiệu quả nhất cho từng loại task.
3. Implement **Agent checkpointing**: save/restore agent state để resume interrupted tasks.

---

*Tiếp theo: [Bài 18 — Multi-Agent Orchestration](18-multi-agent-orchestration.md)*

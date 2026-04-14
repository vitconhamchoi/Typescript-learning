/**
 * Bài 9: LLM Orchestration with TypeScript
 * ==========================================
 * Chạy: npm run lesson09
 *
 * Nội dung:
 *  - Typed prompt templates
 *  - Chain of Responsibility (PromptChain)
 *  - Tool calling / function calling (Zod schema)
 *  - Streaming token aggregator
 *  - Memory: ConversationBuffer + SlidingWindow
 */

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// 1. PROMPT TEMPLATE ENGINE
// ─────────────────────────────────────────────────────────────────────────────

type TemplateVars<T extends string> = Record<T, string | number>;

class PromptTemplate<TVar extends string> {
  constructor(
    private readonly template: string,
    private readonly requiredVars: readonly TVar[],
  ) {}

  render(vars: TemplateVars<TVar>): string {
    let result = this.template;
    for (const key of this.requiredVars) {
      const value = String(vars[key]);
      result = result.replaceAll(`{{${key}}}`, value);
    }
    return result;
  }

  static create<T extends string>(template: string): PromptTemplate<T> {
    const vars = [...template.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1] as T);
    return new PromptTemplate(template, vars);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. TOOL / FUNCTION CALLING
// ─────────────────────────────────────────────────────────────────────────────

// Zod-based tool definition
function defineTool<TInput extends z.ZodTypeAny, TOutput>(config: {
  name: string;
  description: string;
  inputSchema: TInput;
  execute: (input: z.infer<TInput>) => Promise<TOutput>;
}) {
  return {
    ...config,
    jsonSchema: zodToJsonSchema(config.inputSchema),
    async run(rawInput: unknown): Promise<TOutput> {
      const parsed = config.inputSchema.parse(rawInput);
      return config.execute(parsed);
    },
  };
}

// Minimal Zod → JSON Schema converter (production: use zod-to-json-schema)
function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  if (schema instanceof z.ZodObject) {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(schema.shape as Record<string, z.ZodTypeAny>)) {
      properties[key] = zodToJsonSchema(value);
      if (!(value instanceof z.ZodOptional)) required.push(key);
    }
    return { type: "object", properties, required };
  }
  if (schema instanceof z.ZodString)  return { type: "string" };
  if (schema instanceof z.ZodNumber)  return { type: "number" };
  if (schema instanceof z.ZodBoolean) return { type: "boolean" };
  if (schema instanceof z.ZodArray)   return { type: "array", items: zodToJsonSchema(schema.element) };
  if (schema instanceof z.ZodOptional) return zodToJsonSchema(schema.unwrap());
  if (schema instanceof z.ZodEnum)    return { type: "string", enum: schema.options };
  return {};
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. TOOL REGISTRY
// ─────────────────────────────────────────────────────────────────────────────

type AnyTool = ReturnType<typeof defineTool>;

class ToolRegistry {
  private tools = new Map<string, AnyTool>();

  register(tool: AnyTool): void { this.tools.set(tool.name, tool); }

  async execute(name: string, input: unknown): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    return tool.run(input);
  }

  toOpenAITools(): Array<{ type: "function"; function: { name: string; description: string; parameters: unknown } }> {
    return [...this.tools.values()].map(t => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.jsonSchema },
    }));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. CONVERSATION MEMORY
// ─────────────────────────────────────────────────────────────────────────────

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
}

class ConversationBuffer {
  private messages: ChatMessage[] = [];

  add(message: ChatMessage): void { this.messages.push(message); }

  /** Sliding window: keep system + last N messages */
  getWindow(maxMessages: number, systemPrompt?: string): ChatMessage[] {
    const system: ChatMessage[] = systemPrompt ? [{ role: "system", content: systemPrompt }] : [];
    const recent = this.messages.slice(-maxMessages);
    return [...system, ...recent];
  }

  get length(): number { return this.messages.length; }
  get all(): readonly ChatMessage[] { return [...this.messages]; }
  clear(): void { this.messages = []; }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. STREAMING TOKEN AGGREGATOR
// ─────────────────────────────────────────────────────────────────────────────

interface StreamChunk {
  delta: string;
  finishReason: "stop" | "length" | "tool_call" | null;
  model: string;
}

async function* mockLLMStream(prompt: string, model: string): AsyncGenerator<StreamChunk> {
  const words = `[${model}] Responding to: ${prompt.slice(0, 40)}`.split(" ");
  for (const word of words) {
    await new Promise(r => setTimeout(r, 10));
    yield { delta: word + " ", finishReason: null, model };
  }
  yield { delta: "", finishReason: "stop", model };
}

async function aggregateStream(stream: AsyncGenerator<StreamChunk>): Promise<{ content: string; model: string }> {
  let content = "";
  let model   = "";
  for await (const chunk of stream) {
    content += chunk.delta;
    model    = chunk.model;
    process.stdout.write(chunk.delta);
  }
  console.log();
  return { content: content.trim(), model };
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. LLM CHAIN (sequential composition)
// ─────────────────────────────────────────────────────────────────────────────

interface ChainStep {
  name: string;
  template: PromptTemplate<string>;
  outputKey: string;
}

class LLMChain {
  private steps: ChainStep[] = [];

  addStep(step: ChainStep): this { this.steps.push(step); return this; }

  async run(
    initialInput: Record<string, string>,
    llm: (prompt: string) => Promise<string>,
  ): Promise<Record<string, string>> {
    let context: Record<string, string> = { ...initialInput };
    for (const step of this.steps) {
      console.log(`  [Chain] Step: ${step.name}`);
      const prompt   = step.template.render(context as never);
      const response = await llm(prompt);
      context[step.outputKey] = response;
    }
    return context;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DEMO / RUN
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n══════════════════════════════════════");
  console.log(" Bài 9: LLM Orchestration");
  console.log("══════════════════════════════════════\n");

  // ── Prompt Templates ──
  console.log("[Prompt Templates]");
  const systemTpl = PromptTemplate.create<"language" | "style">(
    "You are a helpful assistant. Respond in {{language}} with a {{style}} tone.",
  );
  const userTpl = PromptTemplate.create<"question" | "context">(
    "Context: {{context}}\n\nQuestion: {{question}}",
  );
  console.log("  System:", systemTpl.render({ language: "Vietnamese", style: "professional" }));
  console.log("  User:", userTpl.render({ context: "TypeScript course", question: "What are CRDTs?" }));

  // ── Tool Definitions ──
  console.log("\n[Tool Calling]");
  const registry = new ToolRegistry();

  const searchTool = defineTool({
    name: "search_docs",
    description: "Search documentation for a given query",
    inputSchema: z.object({ query: z.string(), maxResults: z.number().optional() }),
    execute: async ({ query, maxResults = 3 }) => ({
      results: Array.from({ length: maxResults }, (_, i) => ({
        title: `Result ${i + 1} for "${query}"`,
        url:   `/docs/${i + 1}`,
        score: 1 - i * 0.1,
      })),
    }),
  });

  const calculatorTool = defineTool({
    name: "calculate",
    description: "Evaluate a mathematical expression",
    inputSchema: z.object({ expression: z.string() }),
    execute: async ({ expression }) => {
      // Safe eval (demo only — never use eval in production)
      try {
        const result = Function(`"use strict"; return (${expression})`)();
        return { result, expression };
      } catch {
        return { error: "Invalid expression", expression };
      }
    },
  });

  registry.register(searchTool);
  registry.register(calculatorTool);

  const searchResult = await registry.execute("search_docs", { query: "offline-first", maxResults: 2 });
  console.log("  search_docs:", JSON.stringify(searchResult, null, 2).slice(0, 200));

  const calcResult = await registry.execute("calculate", { expression: "2 ** 10 + 24" });
  console.log("  calculate:", calcResult);

  console.log("\n  OpenAI tools schema:");
  registry.toOpenAITools().forEach(t => {
    console.log(`    - ${t.function.name}: ${t.function.description}`);
  });

  // ── Conversation Memory ──
  console.log("\n[Conversation Memory]");
  const memory = new ConversationBuffer();
  memory.add({ role: "user",      content: "What is TypeScript?" });
  memory.add({ role: "assistant", content: "TypeScript is a typed superset of JavaScript." });
  memory.add({ role: "user",      content: "How does it help with AI systems?" });
  memory.add({ role: "assistant", content: "TypeScript provides type safety for complex AI pipelines." });
  memory.add({ role: "user",      content: "Give me an example." });

  const window = memory.getWindow(3, "You are an expert TypeScript developer.");
  console.log(`  Total messages: ${memory.length}, Window size: ${window.length}`);
  window.forEach(m => console.log(`    [${m.role}]: ${m.content.slice(0, 60)}`));

  // ── Streaming ──
  console.log("\n[Streaming LLM Response]");
  process.stdout.write("  > ");
  const { content, model } = await aggregateStream(mockLLMStream("Explain CRDTs briefly", "gpt-4o"));
  console.log(`  Model: ${model} | Content length: ${content.length} chars`);

  // ── LLM Chain ──
  console.log("\n[LLM Chain — Sequential Steps]");
  const chain = new LLMChain()
    .addStep({
      name: "summarize",
      template: PromptTemplate.create<"text">("Summarize in one sentence: {{text}}"),
      outputKey: "summary",
    })
    .addStep({
      name: "translate",
      template: PromptTemplate.create<"summary">("Translate to Vietnamese: {{summary}}"),
      outputKey: "translation",
    });

  const mockLLM = async (prompt: string): Promise<string> => `[Mock response to: ${prompt.slice(0, 50)}...]`;

  const result = await chain.run({ text: "TypeScript enables type-safe AI orchestration at scale." }, mockLLM);
  console.log("  Summary:", result["summary"]);
  console.log("  Translation:", result["translation"]);

  console.log("\n✅ Bài 9 hoàn thành!\n");
}

main().catch(console.error);

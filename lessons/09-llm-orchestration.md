# Bài 9: LLM Orchestration với TypeScript

## Mục tiêu bài học

- Xây dựng Prompt Chain system type-safe
- Implement Tool Calling với strict TypeScript typing
- Streaming với real-time token processing
- Memory management cho long conversations
- LangChain.js integration patterns

---

## 9.1 Type-Safe Prompt Chain

```typescript
// Chain step definition
interface ChainStep<Input, Output> {
  name: string;
  description: string;
  execute(input: Input, context: ChainContext): Promise<Output>;
  onError?: (error: Error, input: Input) => Promise<Output | never>;
}

interface ChainContext {
  memory: ChainMemory;
  tools: Map<string, ToolHandler>;
  config: ChainConfig;
  trace: ChainTrace;
}

interface ChainConfig {
  model: string;
  temperature: number;
  maxTokens: number;
  maxRetries: number;
  timeoutMs: number;
}

interface ChainTrace {
  chainId: string;
  steps: StepTrace[];
  startedAt: Date;
}

interface StepTrace {
  stepName: string;
  startedAt: Date;
  completedAt?: Date;
  inputTokens: number;
  outputTokens: number;
  error?: string;
}

// Chain Memory
class ChainMemory {
  private store = new Map<string, unknown>();
  private conversationHistory: Array<{ role: string; content: string }> = [];

  set<T>(key: string, value: T): void {
    this.store.set(key, value);
  }

  get<T>(key: string): T | undefined {
    return this.store.get(key) as T | undefined;
  }

  addMessage(role: string, content: string): void {
    this.conversationHistory.push({ role, content });
  }

  getHistory(maxMessages?: number): Array<{ role: string; content: string }> {
    if (maxMessages) {
      return this.conversationHistory.slice(-maxMessages);
    }
    return [...this.conversationHistory];
  }

  clearHistory(): void {
    this.conversationHistory = [];
  }

  // Sliding window to fit within context limit
  getHistoryWithinTokenLimit(
    maxTokens: number,
    estimateTokens: (text: string) => number
  ): Array<{ role: string; content: string }> {
    const history = [...this.conversationHistory];
    let tokenCount = 0;
    const result: typeof history = [];

    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i];
      const tokens = estimateTokens(msg.content);
      if (tokenCount + tokens > maxTokens) break;
      result.unshift(msg);
      tokenCount += tokens;
    }

    return result;
  }
}

// Type-safe chain builder
class Chain<Input, Output> {
  private steps: Array<ChainStep<unknown, unknown>> = [];

  static create<I, O>(
    firstStep: ChainStep<I, O>
  ): Chain<I, O> {
    const chain = new Chain<I, O>();
    chain.steps.push(firstStep as ChainStep<unknown, unknown>);
    return chain;
  }

  pipe<NextOutput>(
    step: ChainStep<Output, NextOutput>
  ): Chain<Input, NextOutput> {
    (this as unknown as Chain<Input, NextOutput>).steps.push(
      step as ChainStep<unknown, unknown>
    );
    return this as unknown as Chain<Input, NextOutput>;
  }

  async run(input: Input, context: ChainContext): Promise<Output> {
    let current: unknown = input;

    for (const step of this.steps) {
      const stepTrace: StepTrace = {
        stepName: step.name,
        startedAt: new Date(),
        inputTokens: 0,
        outputTokens: 0,
      };
      context.trace.steps.push(stepTrace);

      try {
        current = await step.execute(current, context);
        stepTrace.completedAt = new Date();
      } catch (error) {
        stepTrace.error = error instanceof Error ? error.message : String(error);
        if (step.onError) {
          current = await step.onError(error as Error, current as never);
        } else {
          throw error;
        }
      }
    }

    return current as Output;
  }
}
```

---

## 9.2 Tool Calling System

```typescript
// Type-safe tool definition
interface ToolSchema<TInput, TOutput> {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, ParameterSchema>;
    required: string[];
  };
  execute(input: TInput, context: ChainContext): Promise<TOutput>;
}

interface ParameterSchema {
  type: "string" | "number" | "boolean" | "array" | "object";
  description: string;
  enum?: string[];
  items?: ParameterSchema;
  properties?: Record<string, ParameterSchema>;
}

type ToolHandler = {
  schema: ToolSchema<unknown, unknown>;
  execute(input: unknown, context: ChainContext): Promise<unknown>;
};

// Tool registry with type inference
class ToolRegistry {
  private tools = new Map<string, ToolHandler>();

  register<TInput, TOutput>(tool: ToolSchema<TInput, TOutput>): void {
    this.tools.set(tool.name, {
      schema: tool as ToolSchema<unknown, unknown>,
      execute: (input, ctx) => tool.execute(input as TInput, ctx),
    });
  }

  getHandler(name: string): ToolHandler | undefined {
    return this.tools.get(name);
  }

  getOpenAITools(): Array<{
    type: "function";
    function: { name: string; description: string; parameters: unknown };
  }> {
    return Array.from(this.tools.values()).map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.schema.name,
        description: tool.schema.description,
        parameters: tool.schema.parameters,
      },
    }));
  }
}

// Example tools for AI assistant

// Web search tool
interface SearchInput {
  query: string;
  maxResults?: number;
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const webSearchTool: ToolSchema<SearchInput, SearchResult[]> = {
  name: "web_search",
  description: "Search the web for current information",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search query",
      },
      maxResults: {
        type: "number",
        description: "Maximum number of results (1-10)",
      },
    },
    required: ["query"],
  },
  async execute(input) {
    // In production: call actual search API (Serper, Bing, etc.)
    console.log(`Searching for: ${input.query}`);
    return [
      {
        title: "Search Result 1",
        url: "https://example.com/1",
        snippet: "Result snippet 1",
      },
    ];
  },
};

// Code execution tool
interface CodeInput {
  language: "python" | "javascript" | "typescript";
  code: string;
  timeout?: number;
}

interface CodeOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const codeExecutorTool: ToolSchema<CodeInput, CodeOutput> = {
  name: "execute_code",
  description: "Execute code in a sandboxed environment",
  parameters: {
    type: "object",
    properties: {
      language: {
        type: "string",
        description: "Programming language",
        enum: ["python", "javascript", "typescript"],
      },
      code: {
        type: "string",
        description: "Code to execute",
      },
      timeout: {
        type: "number",
        description: "Timeout in seconds (max 30)",
      },
    },
    required: ["language", "code"],
  },
  async execute(input) {
    // In production: call sandboxed code execution service
    return { stdout: "Result", stderr: "", exitCode: 0 };
  },
};

// Tool execution orchestrator
class ToolExecutor {
  constructor(private registry: ToolRegistry) {}

  async executeToolCall(
    toolCall: { id: string; name: string; arguments: string },
    context: ChainContext
  ): Promise<{ toolCallId: string; content: string }> {
    const handler = this.registry.getHandler(toolCall.name);
    if (!handler) {
      throw new Error(`Unknown tool: ${toolCall.name}`);
    }

    let args: unknown;
    try {
      args = JSON.parse(toolCall.arguments);
    } catch {
      throw new Error(`Invalid tool arguments: ${toolCall.arguments}`);
    }

    const result = await handler.execute(args, context);
    return {
      toolCallId: toolCall.id,
      content: JSON.stringify(result),
    };
  }

  async executeAllToolCalls(
    toolCalls: Array<{ id: string; name: string; arguments: string }>,
    context: ChainContext
  ): Promise<Array<{ toolCallId: string; content: string }>> {
    return Promise.all(
      toolCalls.map((tc) => this.executeToolCall(tc, context))
    );
  }
}
```

---

## 9.3 ReAct Agent Loop với Streaming

```typescript
// ReAct: Reason + Act pattern
class ReActAgent {
  private maxIterations = 10;

  constructor(
    private llmClient: {
      complete(req: {
        model: string;
        messages: Array<{ role: string; content: string; tool_call_id?: string; tool_calls?: unknown[] }>;
        tools?: unknown[];
        tool_choice?: string;
      }): Promise<{
        content: string;
        tool_calls?: Array<{ id: string; name: string; arguments: string }>;
        finish_reason: string;
        usage: { promptTokens: number; completionTokens: number };
      }>;
    },
    private toolExecutor: ToolExecutor,
    private toolRegistry: ToolRegistry,
    private config: ChainConfig
  ) {}

  async run(
    userMessage: string,
    context: ChainContext
  ): Promise<string> {
    const messages: Array<{ role: string; content: string; tool_call_id?: string; tool_calls?: unknown[] }> = [
      { role: "system", content: this.buildSystemPrompt() },
      ...context.memory.getHistory(),
      { role: "user", content: userMessage },
    ];

    for (let iteration = 0; iteration < this.maxIterations; iteration++) {
      const response = await this.llmClient.complete({
        model: this.config.model,
        messages,
        tools: this.toolRegistry.getOpenAITools(),
        tool_choice: "auto",
      });

      // If no tool calls, we have the final answer
      if (!response.tool_calls || response.tool_calls.length === 0) {
        const answer = response.content;
        context.memory.addMessage("assistant", answer);
        return answer;
      }

      // Execute tool calls
      console.log(`[ReAct] Iteration ${iteration + 1}: executing ${response.tool_calls.length} tools`);
      
      // Add assistant message with tool calls
      messages.push({
        role: "assistant",
        content: response.content,
        tool_calls: response.tool_calls,
      });

      // Execute all tool calls in parallel
      const toolResults = await context.tools
        ? this.toolExecutor.executeAllToolCalls(response.tool_calls, context)
        : Promise.resolve([]);

      // Add tool results to messages
      const results = await toolResults;
      for (const result of results) {
        messages.push({
          role: "tool",
          content: result.content,
          tool_call_id: result.toolCallId,
        });
      }
    }

    throw new Error(`Max iterations (${this.maxIterations}) reached without final answer`);
  }

  private buildSystemPrompt(): string {
    return `You are a helpful AI assistant with access to tools.
Use tools when you need to retrieve information or perform actions.
Think step by step before taking actions.
When you have enough information, provide a clear and concise answer.`;
  }
}

// Streaming version with real-time output
class StreamingReActAgent {
  constructor(
    private llmStreamer: {
      stream(req: unknown): AsyncIterable<{ delta: string; finish_reason: string | null; tool_call_delta?: { id?: string; name?: string; arguments?: string } }>;
    },
    private toolExecutor: ToolExecutor,
    private toolRegistry: ToolRegistry
  ) {}

  async *run(
    userMessage: string,
    context: ChainContext
  ): AsyncIterable<{ type: "thinking" | "content" | "tool_call" | "tool_result" | "done"; data: string }> {
    const messages: Array<{ role: string; content: string }> = [
      { role: "system", content: "You are a helpful AI assistant." },
      { role: "user", content: userMessage },
    ];

    for (let iteration = 0; iteration < 10; iteration++) {
      let fullContent = "";
      let toolCallBuffer = { id: "", name: "", arguments: "" };
      let isToolCall = false;

      // Stream response
      for await (const chunk of this.llmStreamer.stream({
        messages,
        tools: this.toolRegistry.getOpenAITools(),
      })) {
        if (chunk.tool_call_delta) {
          isToolCall = true;
          if (chunk.tool_call_delta.id) toolCallBuffer.id = chunk.tool_call_delta.id;
          if (chunk.tool_call_delta.name) toolCallBuffer.name += chunk.tool_call_delta.name;
          if (chunk.tool_call_delta.arguments) toolCallBuffer.arguments += chunk.tool_call_delta.arguments;
          
          yield { type: "thinking", data: "..." };
        } else if (chunk.delta) {
          fullContent += chunk.delta;
          yield { type: "content", data: chunk.delta };
        }

        if (chunk.finish_reason === "stop") {
          yield { type: "done", data: fullContent };
          return;
        }
      }

      if (isToolCall && toolCallBuffer.name) {
        yield {
          type: "tool_call",
          data: `Calling ${toolCallBuffer.name}...`,
        };

        const result = await this.toolExecutor.executeToolCall(
          toolCallBuffer,
          context
        );

        yield {
          type: "tool_result",
          data: result.content,
        };

        messages.push(
          { role: "assistant", content: "" },
          { role: "tool", content: result.content }
        );
      }
    }
  }
}
```

---

## 9.4 Advanced Memory Management

```typescript
// Hierarchical memory for long-running agents
interface MemoryTier {
  name: string;
  capacity: number;   // Max items
  ttl: number;        // Time-to-live in ms
}

class HierarchicalMemory {
  // Working memory: last N messages (in-context)
  private workingMemory: Array<{ role: string; content: string; importance: number }> = [];
  
  // Episodic memory: important past events (compressed)
  private episodicMemory: Array<{
    summary: string;
    timestamp: Date;
    importance: number;
  }> = [];

  // Semantic memory: knowledge extracted from conversations
  private semanticMemory: Map<string, { fact: string; confidence: number; source: string }> = new Map();

  constructor(
    private config: {
      workingMemorySize: number;      // e.g., 20 messages
      episodicMemorySize: number;     // e.g., 50 summaries
      importanceThreshold: number;    // 0-1 score
    },
    private summarizer: {
      summarize(messages: Array<{ role: string; content: string }>): Promise<string>;
      extractFacts(text: string): Promise<Array<{ key: string; fact: string; confidence: number }>>;
    }
  ) {}

  async addMessage(
    role: string,
    content: string,
    importance: number = 0.5
  ): Promise<void> {
    this.workingMemory.push({ role, content, importance });

    // Consolidate when working memory is full
    if (this.workingMemory.length > this.config.workingMemorySize) {
      await this.consolidate();
    }
  }

  private async consolidate(): Promise<void> {
    // Take oldest half of working memory
    const toConsolidate = this.workingMemory.splice(
      0,
      Math.floor(this.config.workingMemorySize / 2)
    );

    // Generate summary
    const summary = await this.summarizer.summarize(toConsolidate);
    const importance = toConsolidate.reduce((s, m) => s + m.importance, 0) / toConsolidate.length;
    
    this.episodicMemory.push({
      summary,
      timestamp: new Date(),
      importance,
    });

    // Extract semantic facts
    const facts = await this.summarizer.extractFacts(
      toConsolidate.map((m) => m.content).join("\n")
    );
    for (const { key, fact, confidence } of facts) {
      if (confidence > this.config.importanceThreshold) {
        this.semanticMemory.set(key, { fact, confidence, source: summary.slice(0, 50) });
      }
    }

    // Trim episodic memory
    if (this.episodicMemory.length > this.config.episodicMemorySize) {
      this.episodicMemory.sort((a, b) => b.importance - a.importance);
      this.episodicMemory = this.episodicMemory.slice(0, this.config.episodicMemorySize);
    }
  }

  buildContext(maxTokens: number = 4000): string {
    const sections: string[] = [];

    // Add relevant semantic facts
    if (this.semanticMemory.size > 0) {
      const facts = Array.from(this.semanticMemory.values())
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 10)
        .map((f) => `- ${f.fact}`)
        .join("\n");
      sections.push(`Known facts:\n${facts}`);
    }

    // Add recent episodic memories
    if (this.episodicMemory.length > 0) {
      const summaries = this.episodicMemory
        .slice(-3)
        .map((e) => e.summary)
        .join("\n\n");
      sections.push(`Previous context:\n${summaries}`);
    }

    return sections.join("\n\n---\n\n");
  }

  getWorkingMemory(): Array<{ role: string; content: string }> {
    return this.workingMemory.map((m) => ({ role: m.role, content: m.content }));
  }
}
```

---

## 9.5 Complete Orchestration Pipeline

```typescript
// Full orchestration example
async function buildAIAssistantPipeline() {
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(webSearchTool);
  toolRegistry.register(codeExecutorTool);

  const config: ChainConfig = {
    model: "gpt-4o",
    temperature: 0.7,
    maxTokens: 2048,
    maxRetries: 3,
    timeoutMs: 30000,
  };

  // Step 1: Classify intent
  const classifyIntent: ChainStep<string, { intent: string; userMessage: string }> = {
    name: "classify_intent",
    description: "Classify user intent",
    async execute(userMessage, context) {
      // Simple classification based on keywords
      const lower = userMessage.toLowerCase();
      let intent = "general";
      if (lower.includes("search") || lower.includes("find") || lower.includes("latest")) {
        intent = "search";
      } else if (lower.includes("code") || lower.includes("script") || lower.includes("function")) {
        intent = "code";
      } else if (lower.includes("calculate") || lower.includes("math") || lower.includes("compute")) {
        intent = "calculation";
      }
      context.memory.set("intent", intent);
      return { intent, userMessage };
    },
  };

  // Step 2: Route to specialized agent
  const routeToAgent: ChainStep<
    { intent: string; userMessage: string },
    { agentType: string; response: string }
  > = {
    name: "route_to_agent",
    description: "Route to specialized agent",
    async execute({ intent, userMessage }, context) {
      // Different system prompts per intent
      const systemPrompts: Record<string, string> = {
        search: "You are a research assistant. Use web search to find accurate information.",
        code: "You are a coding assistant. Write clean, well-documented code.",
        calculation: "You are a math assistant. Show your work step by step.",
        general: "You are a helpful AI assistant.",
      };

      const systemPrompt = systemPrompts[intent] ?? systemPrompts.general;
      context.memory.set("systemPrompt", systemPrompt);
      
      // In real implementation, call actual LLM
      return { agentType: intent, response: `Processed ${intent} request: ${userMessage}` };
    },
  };

  // Step 3: Post-process response
  const postProcess: ChainStep<
    { agentType: string; response: string },
    string
  > = {
    name: "post_process",
    description: "Format and enhance response",
    async execute({ agentType, response }, context) {
      // Add citations, format, etc.
      const processedResponse = response;
      context.memory.addMessage("assistant", processedResponse);
      return processedResponse;
    },
  };

  // Build the chain
  const chain = Chain.create(classifyIntent)
    .pipe(routeToAgent)
    .pipe(postProcess);

  const context: ChainContext = {
    memory: new ChainMemory(),
    tools: new Map(),
    config,
    trace: {
      chainId: crypto.randomUUID(),
      steps: [],
      startedAt: new Date(),
    },
  };

  return { chain, context };
}

// Usage
async function runOrchestration() {
  const { chain, context } = await buildAIAssistantPipeline();

  const userMessage = "What are the latest developments in TypeScript 5.5?";
  context.memory.addMessage("user", userMessage);

  const response = await chain.run(userMessage, context);
  
  console.log("Response:", response);
  console.log("Trace:", context.trace.steps.map((s) => s.stepName));
}
```

---

## Tóm tắt Bài 9

| Component | Pattern | Description |
|-----------|---------|-------------|
| Chain | Builder + Generic pipe | Type-safe sequential processing |
| ToolRegistry | Factory + Map | Extensible tool system |
| ReActAgent | Loop + tool calling | Reasoning + acting cycle |
| StreamingAgent | AsyncGenerator | Real-time output |
| HierarchicalMemory | Working + Episodic + Semantic | Long-term context management |

## Bài tập thực hành

1. Implement **Parallel Tool Execution**: khi agent gọi nhiều independent tools, execute chúng song song thay vì tuần tự.
2. Xây dựng **Tool Approval System**: certain tools require user confirmation trước khi execute (e.g., email sending, file deletion).
3. Implement **Chain Caching**: cache intermediate chain results để avoid re-computation khi chạy similar chains.

---

*Tiếp theo: [Bài 10 — Real-time Sync với WebSockets & SSE](10-realtime-sync-websockets-sse.md)*

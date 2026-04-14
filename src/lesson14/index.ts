/**
 * Bài 14: gRPC & Protocol Buffers in TypeScript
 * ===============================================
 * Chạy: npm run lesson14
 *
 * Nội dung:
 *  - Typed proto message interfaces (mirrors .proto definitions)
 *  - Unary RPC simulation
 *  - Server-streaming (LLM token generation)
 *  - Bidirectional streaming
 *  - Metadata / context propagation
 *  - Deadline / cancellation
 */

import { EventEmitter } from "eventemitter3";

// ─────────────────────────────────────────────────────────────────────────────
// 1. TYPED PROTO MESSAGES (TypeScript interfaces matching .proto)
// ─────────────────────────────────────────────────────────────────────────────

// Mirrors: message ChatMessage { ... }
interface ProtoMessage {
  role: "ROLE_USER" | "ROLE_ASSISTANT" | "ROLE_SYSTEM";
  content: string;
  timestampMs: number;
}

// Mirrors: message ChatRequest { ... }
interface ChatRequest {
  sessionId: string;
  messages: ProtoMessage[];
  model: string;
  maxTokens: number;
  temperature: number;
  stream: boolean;
}

// Mirrors: message ChatResponse { ... }
interface ChatResponse {
  sessionId: string;
  content: string;
  tokensUsed: number;
  finishReason: "FINISH_REASON_STOP" | "FINISH_REASON_MAX_TOKENS" | "FINISH_REASON_TOOL_CALL";
  latencyMs: number;
}

// Mirrors: message StreamChunk { ... }
interface StreamChunk {
  sessionId: string;
  delta: string;
  sequenceId: number;
  finishReason: ChatResponse["finishReason"] | null;
}

// Mirrors: message EmbedRequest { ... }
interface EmbedRequest {
  texts: string[];
  model: string;
  dimensions?: number;
}

// Mirrors: message EmbedResponse { ... }
interface EmbedResponse {
  embeddings: number[][];
  model: string;
  tokensUsed: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. gRPC METADATA & CONTEXT
// ─────────────────────────────────────────────────────────────────────────────

interface GRPCMetadata {
  authorization?: string;
  "x-tenant-id"?: string;
  "x-request-id"?: string;
  "x-trace-id"?: string;
  [key: string]: string | undefined;
}

interface GRPCContext {
  metadata: GRPCMetadata;
  deadlineMs?: number;
  cancelled: boolean;
  cancel(): void;
}

function createContext(metadata: GRPCMetadata, timeoutMs?: number): GRPCContext {
  let cancelled = false;
  const ctx: GRPCContext = {
    metadata,
    get cancelled() { return cancelled; },
    cancel() { cancelled = true; },
  };
  if (timeoutMs !== undefined) {
    ctx.deadlineMs = Date.now() + timeoutMs;
    setTimeout(() => ctx.cancel(), timeoutMs);
  }
  return ctx;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. gRPC SERVICE DEFINITIONS (typed interfaces)
// ─────────────────────────────────────────────────────────────────────────────

interface AIServiceServer {
  chat(request: ChatRequest, ctx: GRPCContext): Promise<ChatResponse>;
  chatStream(request: ChatRequest, ctx: GRPCContext): AsyncIterable<StreamChunk>;
  embed(request: EmbedRequest, ctx: GRPCContext): Promise<EmbedResponse>;
  bidirectionalChat(stream: AsyncIterable<ProtoMessage>, ctx: GRPCContext): AsyncIterable<StreamChunk>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. SERVER IMPLEMENTATION
// ─────────────────────────────────────────────────────────────────────────────

class AIServiceImpl implements AIServiceServer {
  // Unary RPC
  async chat(request: ChatRequest, ctx: GRPCContext): Promise<ChatResponse> {
    if (ctx.cancelled) throw new Error("RPC cancelled");
    const lastMsg = request.messages.at(-1)?.content ?? "";
    const start   = Date.now();
    await new Promise(r => setTimeout(r, 50));
    return {
      sessionId:    request.sessionId,
      content:      `[${request.model}] Mock response to: ${lastMsg.slice(0, 40)}`,
      tokensUsed:   Math.ceil(lastMsg.length / 4) + 50,
      finishReason: "FINISH_REASON_STOP",
      latencyMs:    Date.now() - start,
    };
  }

  // Server-streaming RPC
  async *chatStream(request: ChatRequest, ctx: GRPCContext): AsyncIterable<StreamChunk> {
    const words = `[${request.model}] Streaming response for session ${request.sessionId}`.split(" ");
    let seq = 0;
    for (const word of words) {
      if (ctx.cancelled) return;
      await new Promise(r => setTimeout(r, 10));
      yield { sessionId: request.sessionId, delta: word + " ", sequenceId: seq++, finishReason: null };
    }
    yield { sessionId: request.sessionId, delta: "", sequenceId: seq, finishReason: "FINISH_REASON_STOP" };
  }

  // Unary embed RPC
  async embed(request: EmbedRequest, ctx: GRPCContext): Promise<EmbedResponse> {
    if (ctx.cancelled) throw new Error("RPC cancelled");
    const dims = request.dimensions ?? 1536;
    const embeddings = request.texts.map(() =>
      Array.from({ length: dims }, () => Math.random() * 2 - 1),
    );
    return { embeddings, model: request.model, tokensUsed: request.texts.join(" ").length };
  }

  // Bidirectional streaming
  async *bidirectionalChat(stream: AsyncIterable<ProtoMessage>, ctx: GRPCContext): AsyncIterable<StreamChunk> {
    let seq = 0;
    for await (const msg of stream) {
      if (ctx.cancelled) return;
      await new Promise(r => setTimeout(r, 20));
      const words = `Echo: ${msg.content.slice(0, 30)}`.split(" ");
      for (const word of words) {
        yield { sessionId: "bidir", delta: word + " ", sequenceId: seq++, finishReason: null };
      }
      yield { sessionId: "bidir", delta: "\n", sequenceId: seq++, finishReason: null };
    }
    yield { sessionId: "bidir", delta: "", sequenceId: seq, finishReason: "FINISH_REASON_STOP" };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. gRPC CLIENT STUB (typed proxy)
// ─────────────────────────────────────────────────────────────────────────────

class AIServiceClient {
  constructor(private readonly server: AIServiceServer) {}

  async chat(request: ChatRequest, metadata: GRPCMetadata = {}, timeoutMs = 5000): Promise<ChatResponse> {
    const ctx = createContext(metadata, timeoutMs);
    return this.server.chat(request, ctx);
  }

  chatStream(request: ChatRequest, metadata: GRPCMetadata = {}): AsyncIterable<StreamChunk> {
    const ctx = createContext(metadata);
    return this.server.chatStream(request, ctx);
  }

  async embed(request: EmbedRequest, metadata: GRPCMetadata = {}): Promise<EmbedResponse> {
    const ctx = createContext(metadata);
    return this.server.embed(request, ctx);
  }

  bidirectionalChat(messages: AsyncIterable<ProtoMessage>, metadata: GRPCMetadata = {}): AsyncIterable<StreamChunk> {
    const ctx = createContext(metadata);
    return this.server.bidirectionalChat(messages, ctx);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. INTERCEPTOR (middleware for gRPC)
// ─────────────────────────────────────────────────────────────────────────────

type UnaryInterceptor = <Req, Res>(
  request: Req,
  ctx: GRPCContext,
  next: (req: Req, ctx: GRPCContext) => Promise<Res>,
) => Promise<Res>;

function loggingInterceptor(): UnaryInterceptor {
  return async (request, ctx, next) => {
    const start = Date.now();
    console.log(`  [gRPC] → Request`, ctx.metadata["x-request-id"] ?? "no-id");
    const result = await next(request, ctx);
    console.log(`  [gRPC] ← Response in ${Date.now() - start}ms`);
    return result;
  };
}

function authInterceptor(validToken: string): UnaryInterceptor {
  return async (request, ctx, next) => {
    const token = ctx.metadata["authorization"]?.replace("Bearer ", "");
    if (token !== validToken) throw new Error("gRPC Unauthenticated: invalid token");
    return next(request, ctx);
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// DEMO / RUN
// ─────────────────────────────────────────────────────────────────────────────

async function* messageStream(msgs: string[]): AsyncGenerator<ProtoMessage> {
  for (const content of msgs) {
    await new Promise(r => setTimeout(r, 20));
    yield { role: "ROLE_USER", content, timestampMs: Date.now() };
  }
}

async function main() {
  console.log("\n══════════════════════════════════════");
  console.log(" Bài 14: gRPC & Protocol Buffers");
  console.log("══════════════════════════════════════\n");

  const server = new AIServiceImpl();
  const client = new AIServiceClient(server);

  const baseRequest: ChatRequest = {
    sessionId:   "sess_42",
    messages:    [{ role: "ROLE_USER", content: "Explain TypeScript generics", timestampMs: Date.now() }],
    model:       "gpt-4o",
    maxTokens:   512,
    temperature: 0.7,
    stream:      false,
  };

  // ── Unary RPC ──
  console.log("[Unary RPC — chat]");
  const response = await client.chat(baseRequest, { "x-request-id": "req_001", "x-tenant-id": "tenant_a" });
  console.log(`  Response: "${response.content.slice(0, 60)}..."`);
  console.log(`  Tokens: ${response.tokensUsed} | Latency: ${response.latencyMs}ms | Finish: ${response.finishReason}`);

  // ── Server Streaming ──
  console.log("\n[Server Streaming — chatStream]");
  process.stdout.write("  > ");
  let chunkCount = 0;
  for await (const chunk of client.chatStream({ ...baseRequest, stream: true })) {
    if (chunk.delta) { process.stdout.write(chunk.delta); chunkCount++; }
    if (chunk.finishReason) console.log(`\n  Chunks: ${chunkCount} | Finish: ${chunk.finishReason}`);
  }

  // ── Embed RPC ──
  console.log("\n[Embed RPC]");
  const embedRes = await client.embed({
    texts: ["TypeScript generics", "CRDTs and offline-first", "AI orchestration"],
    model: "text-embedding-3-large",
    dimensions: 4, // small for demo
  });
  console.log(`  Embeddings: ${embedRes.embeddings.length} vectors of dim ${embedRes.embeddings[0]?.length}`);
  console.log(`  First vector: [${embedRes.embeddings[0]?.map(v => v.toFixed(3)).join(", ")}]`);

  // ── Bidirectional Streaming ──
  console.log("\n[Bidirectional Streaming]");
  const questions = ["What is TypeScript?", "How do CRDTs work?", "Explain gRPC"];
  process.stdout.write("  > ");
  for await (const chunk of client.bidirectionalChat(messageStream(questions))) {
    process.stdout.write(chunk.delta);
  }
  console.log();

  // ── Deadline / Cancellation ──
  console.log("\n[Deadline / Cancellation]");
  try {
    await client.chat(baseRequest, {}, 1); // 1ms timeout — will cancel
  } catch (err) {
    console.log(`  ✅ Caught timeout: ${(err as Error).message}`);
  }

  // ── Interceptors ──
  console.log("\n[gRPC Interceptors]");
  const log  = loggingInterceptor();
  const auth = authInterceptor("secret-token");

  const ctx = createContext({ authorization: "Bearer secret-token", "x-request-id": "req_intercepted" });
  const intercepted = await log(baseRequest, ctx, async (req, c) =>
    auth(req, c, (r, cc) => server.chat(r as ChatRequest, cc)),
  );
  console.log(`  Intercepted response: "${(intercepted as ChatResponse).content.slice(0, 50)}..."`);

  // Auth failure
  try {
    const badCtx = createContext({ authorization: "Bearer wrong" });
    await auth(baseRequest, badCtx, (r, c) => server.chat(r as ChatRequest, c));
  } catch (err) {
    console.log(`  ✅ Auth interceptor caught: ${(err as Error).message}`);
  }

  console.log("\n✅ Bài 14 hoàn thành!\n");
}

main().catch(console.error);

# Bài 10: Real-time Sync với WebSockets & SSE

## Mục tiêu bài học

- Xây dựng type-safe WebSocket server với TypeScript
- Implement Server-Sent Events (SSE) cho LLM streaming
- Thiết kế presence system cho collaborative AI
- CRDT sync qua WebSocket cho real-time collaboration
- Reconnection strategy và connection management

---

## 10.1 Type-Safe WebSocket Protocol

```typescript
// Protocol messages — discriminated union cho full type safety
type ServerMessage =
  | { type: "connected"; sessionId: string; userId: string }
  | { type: "ai_chunk"; conversationId: string; messageId: string; delta: string; tokenCount: number }
  | { type: "ai_complete"; conversationId: string; messageId: string; usage: TokenUsage; latencyMs: number }
  | { type: "ai_error"; conversationId: string; error: string; code: string }
  | { type: "sync_update"; entityType: string; entityId: string; data: unknown; version: number }
  | { type: "presence_update"; users: PresenceInfo[] }
  | { type: "typing_indicator"; conversationId: string; userId: string; isTyping: boolean }
  | { type: "pong"; timestamp: number }
  | { type: "error"; code: string; message: string };

type ClientMessage =
  | { type: "send_message"; conversationId: string; content: string; requestId: string }
  | { type: "cancel_generation"; conversationId: string; messageId: string }
  | { type: "sync_request"; entityType: string; entityId: string; fromVersion: number }
  | { type: "presence_join"; conversationId: string }
  | { type: "presence_leave"; conversationId: string }
  | { type: "typing_start"; conversationId: string }
  | { type: "typing_stop"; conversationId: string }
  | { type: "ping"; timestamp: number };

interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

interface PresenceInfo {
  userId: string;
  name: string;
  avatar?: string;
  status: "online" | "idle" | "offline";
  currentConversation?: string;
  lastSeen: Date;
}

// Type-safe message serialization
function serialize(message: ServerMessage | ClientMessage): string {
  return JSON.stringify(message);
}

function deserializeServer(data: string): ServerMessage {
  const parsed = JSON.parse(data) as ServerMessage;
  return parsed;
}

function deserializeClient(data: string): ClientMessage {
  const parsed = JSON.parse(data) as ClientMessage;
  return parsed;
}
```

---

## 10.2 WebSocket Server (Node.js với ws)

```typescript
import { WebSocketServer, WebSocket } from "ws";
import { IncomingMessage } from "http";

interface ConnectedClient {
  ws: WebSocket;
  userId: string;
  sessionId: string;
  subscriptions: Set<string>;   // conversationIds
  lastPing: Date;
  metadata: Record<string, unknown>;
}

class AIWebSocketServer {
  private wss: WebSocketServer;
  private clients = new Map<string, ConnectedClient>(); // sessionId -> client
  private conversationRooms = new Map<string, Set<string>>(); // conversationId -> sessionIds
  private pingInterval: ReturnType<typeof setInterval>;

  constructor(
    private port: number,
    private services: {
      auth: { verifyToken(token: string): Promise<{ userId: string } | null> };
      llm: { stream(messages: unknown[], model: string): AsyncIterable<{ delta: string; finish_reason: string | null }> };
      sync: { getUpdates(entityType: string, entityId: string, fromVersion: number): Promise<{ data: unknown; version: number }> };
    }
  ) {
    this.wss = new WebSocketServer({ port });
    this.setupServer();
    this.pingInterval = setInterval(() => this.pingAllClients(), 30000);
  }

  private setupServer(): void {
    this.wss.on("connection", async (ws: WebSocket, req: IncomingMessage) => {
      const sessionId = crypto.randomUUID();
      
      try {
        // Authenticate
        const token = this.extractToken(req);
        if (!token) {
          ws.close(4001, "Unauthorized");
          return;
        }

        const auth = await this.services.auth.verifyToken(token);
        if (!auth) {
          ws.close(4001, "Invalid token");
          return;
        }

        // Register client
        const client: ConnectedClient = {
          ws,
          userId: auth.userId,
          sessionId,
          subscriptions: new Set(),
          lastPing: new Date(),
          metadata: {},
        };
        this.clients.set(sessionId, client);

        // Send connected confirmation
        this.send(ws, {
          type: "connected",
          sessionId,
          userId: auth.userId,
        });

        console.log(`[WS] Client connected: ${auth.userId} (${sessionId})`);

        // Handle messages
        ws.on("message", async (data) => {
          try {
            const message = deserializeClient(data.toString());
            await this.handleMessage(sessionId, message);
          } catch (error) {
            console.error("[WS] Message error:", error);
            this.send(ws, {
              type: "error",
              code: "MESSAGE_ERROR",
              message: "Failed to process message",
            });
          }
        });

        // Handle disconnect
        ws.on("close", () => {
          this.handleDisconnect(sessionId);
        });

        ws.on("error", (error) => {
          console.error(`[WS] Client error (${sessionId}):`, error);
          this.handleDisconnect(sessionId);
        });

      } catch (error) {
        console.error("[WS] Connection error:", error);
        ws.close(4000, "Server error");
      }
    });
  }

  private async handleMessage(
    sessionId: string,
    message: ClientMessage
  ): Promise<void> {
    const client = this.clients.get(sessionId);
    if (!client) return;

    switch (message.type) {
      case "ping":
        client.lastPing = new Date();
        this.send(client.ws, { type: "pong", timestamp: Date.now() });
        break;

      case "send_message":
        await this.handleAIMessage(client, message);
        break;

      case "cancel_generation":
        // Cancel ongoing generation for this conversation
        break;

      case "sync_request":
        await this.handleSyncRequest(client, message);
        break;

      case "presence_join":
        this.joinRoom(sessionId, message.conversationId);
        await this.broadcastPresence(message.conversationId);
        break;

      case "presence_leave":
        this.leaveRoom(sessionId, message.conversationId);
        await this.broadcastPresence(message.conversationId);
        break;

      case "typing_start":
      case "typing_stop":
        this.broadcastToRoom(message.conversationId, sessionId, {
          type: "typing_indicator",
          conversationId: message.conversationId,
          userId: client.userId,
          isTyping: message.type === "typing_start",
        });
        break;
    }
  }

  private async handleAIMessage(
    client: ConnectedClient,
    message: Extract<ClientMessage, { type: "send_message" }>
  ): Promise<void> {
    const messageId = crypto.randomUUID();
    const startTime = Date.now();
    let totalTokens = 0;

    try {
      const stream = this.services.llm.stream(
        [{ role: "user", content: message.content }],
        "gpt-4o"
      );

      for await (const chunk of stream) {
        const tokens = chunk.delta.length / 4; // Rough estimate
        totalTokens += tokens;

        this.send(client.ws, {
          type: "ai_chunk",
          conversationId: message.conversationId,
          messageId,
          delta: chunk.delta,
          tokenCount: Math.ceil(tokens),
        });

        if (chunk.finish_reason === "stop") break;
      }

      this.send(client.ws, {
        type: "ai_complete",
        conversationId: message.conversationId,
        messageId,
        usage: {
          promptTokens: 0,
          completionTokens: Math.ceil(totalTokens),
          totalTokens: Math.ceil(totalTokens),
        },
        latencyMs: Date.now() - startTime,
      });

    } catch (error) {
      this.send(client.ws, {
        type: "ai_error",
        conversationId: message.conversationId,
        error: error instanceof Error ? error.message : "Unknown error",
        code: "AI_ERROR",
      });
    }
  }

  private async handleSyncRequest(
    client: ConnectedClient,
    message: Extract<ClientMessage, { type: "sync_request" }>
  ): Promise<void> {
    const updates = await this.services.sync.getUpdates(
      message.entityType,
      message.entityId,
      message.fromVersion
    );

    this.send(client.ws, {
      type: "sync_update",
      entityType: message.entityType,
      entityId: message.entityId,
      data: updates.data,
      version: updates.version,
    });
  }

  private send(ws: WebSocket, message: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(serialize(message));
    }
  }

  private joinRoom(sessionId: string, conversationId: string): void {
    if (!this.conversationRooms.has(conversationId)) {
      this.conversationRooms.set(conversationId, new Set());
    }
    this.conversationRooms.get(conversationId)!.add(sessionId);
    this.clients.get(sessionId)?.subscriptions.add(conversationId);
  }

  private leaveRoom(sessionId: string, conversationId: string): void {
    this.conversationRooms.get(conversationId)?.delete(sessionId);
    this.clients.get(sessionId)?.subscriptions.delete(conversationId);
    if (this.conversationRooms.get(conversationId)?.size === 0) {
      this.conversationRooms.delete(conversationId);
    }
  }

  private broadcastToRoom(
    conversationId: string,
    excludeSessionId: string,
    message: ServerMessage
  ): void {
    const sessionIds = this.conversationRooms.get(conversationId) ?? new Set();
    for (const sessionId of sessionIds) {
      if (sessionId === excludeSessionId) continue;
      const client = this.clients.get(sessionId);
      if (client) this.send(client.ws, message);
    }
  }

  private async broadcastPresence(conversationId: string): Promise<void> {
    const sessionIds = this.conversationRooms.get(conversationId) ?? new Set();
    const users: PresenceInfo[] = Array.from(sessionIds)
      .map((id) => this.clients.get(id))
      .filter((c): c is ConnectedClient => c !== undefined)
      .map((c) => ({
        userId: c.userId,
        name: c.userId, // In production: fetch display name
        status: "online" as const,
        currentConversation: conversationId,
        lastSeen: c.lastPing,
      }));

    for (const sessionId of sessionIds) {
      const client = this.clients.get(sessionId);
      if (client) {
        this.send(client.ws, { type: "presence_update", users });
      }
    }
  }

  private handleDisconnect(sessionId: string): void {
    const client = this.clients.get(sessionId);
    if (!client) return;

    // Leave all rooms
    for (const conversationId of client.subscriptions) {
      this.leaveRoom(sessionId, conversationId);
      this.broadcastPresence(conversationId);
    }

    this.clients.delete(sessionId);
    console.log(`[WS] Client disconnected: ${client.userId} (${sessionId})`);
  }

  private pingAllClients(): void {
    const now = Date.now();
    const timeout = 60000; // 60s timeout

    for (const [sessionId, client] of this.clients) {
      if (now - client.lastPing.getTime() > timeout) {
        console.log(`[WS] Timing out client: ${sessionId}`);
        client.ws.close(4008, "Ping timeout");
        this.handleDisconnect(sessionId);
      }
    }
  }

  private extractToken(req: IncomingMessage): string | null {
    const auth = req.headers.authorization;
    if (auth?.startsWith("Bearer ")) return auth.slice(7);
    
    const url = new URL(req.url ?? "", "http://localhost");
    return url.searchParams.get("token");
  }

  getStats() {
    return {
      connectedClients: this.clients.size,
      activeRooms: this.conversationRooms.size,
    };
  }

  close(): void {
    clearInterval(this.pingInterval);
    this.wss.close();
  }
}
```

---

## 10.3 Server-Sent Events (SSE) cho LLM Streaming

SSE là đơn giản hơn WebSocket và perfect cho one-way streaming (LLM responses):

```typescript
import { createServer, IncomingMessage, ServerResponse } from "http";

// SSE handler factory
function createSSEHandler(
  llmStreamer: {
    stream(
      messages: Array<{ role: string; content: string }>,
      options: { model: string; temperature: number }
    ): AsyncIterable<{ delta: string; finish_reason: string | null; usage?: TokenUsage }>;
  }
) {
  return async function handleSSE(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    // Parse request
    const body = await readBody(req);
    const { messages, model, temperature, conversationId } = JSON.parse(body) as {
      messages: Array<{ role: string; content: string }>;
      model: string;
      temperature: number;
      conversationId: string;
    };

    // Set SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "X-Accel-Buffering": "no", // Disable nginx buffering
    });

    // Helper to send SSE events
    function sendEvent<T>(event: string, data: T): void {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    }

    // Handle client disconnect
    let aborted = false;
    req.on("close", () => {
      aborted = true;
    });

    try {
      sendEvent("start", { conversationId, timestamp: Date.now() });

      const stream = llmStreamer.stream(messages, { model, temperature });

      for await (const chunk of stream) {
        if (aborted) break;

        sendEvent("chunk", {
          delta: chunk.delta,
          conversationId,
        });

        if (chunk.finish_reason) {
          sendEvent("complete", {
            conversationId,
            finishReason: chunk.finish_reason,
            usage: chunk.usage,
          });
          break;
        }
      }
    } catch (error) {
      sendEvent("error", {
        message: error instanceof Error ? error.message : "Unknown error",
        code: "STREAM_ERROR",
      });
    } finally {
      res.end();
    }
  };
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}
```

---

## 10.4 Client-Side WebSocket Manager

```typescript
// Robust WebSocket client với auto-reconnect
class AIWebSocketClient {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 1000;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private handlers = new Map<string, Set<(data: unknown) => void>>();
  private pendingMessages: ClientMessage[] = [];
  private isConnecting = false;

  constructor(
    private url: string,
    private getToken: () => Promise<string>
  ) {}

  async connect(): Promise<void> {
    if (this.isConnecting || this.ws?.readyState === WebSocket.OPEN) return;
    this.isConnecting = true;

    try {
      const token = await this.getToken();
      const wsUrl = `${this.url}?token=${token}`;

      this.ws = new WebSocket(wsUrl);

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Connection timeout")), 10000);

        this.ws!.onopen = () => {
          clearTimeout(timeout);
          resolve();
        };

        this.ws!.onerror = (error) => {
          clearTimeout(timeout);
          reject(error);
        };
      });

      this.isConnecting = false;
      this.reconnectAttempts = 0;
      this.startPing();
      this.flushPendingMessages();

      this.ws.onmessage = (event) => {
        try {
          const message = deserializeServer(event.data as string);
          this.emit(message.type, message);
        } catch (error) {
          console.error("[WS Client] Parse error:", error);
        }
      };

      this.ws.onclose = (event) => {
        this.stopPing();
        if (!event.wasClean) {
          this.scheduleReconnect();
        }
      };

      this.ws.onerror = () => {
        this.scheduleReconnect();
      };

    } catch (error) {
      this.isConnecting = false;
      console.error("[WS Client] Connection failed:", error);
      this.scheduleReconnect();
    }
  }

  send(message: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(serialize(message));
    } else {
      this.pendingMessages.push(message);
    }
  }

  on<T extends ServerMessage["type"]>(
    type: T,
    handler: (data: Extract<ServerMessage, { type: T }>) => void
  ): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)!.add(handler as (data: unknown) => void);
    return () => this.handlers.get(type)?.delete(handler as (data: unknown) => void);
  }

  private emit(type: string, data: unknown): void {
    this.handlers.get(type)?.forEach((h) => h(data));
    this.handlers.get("*")?.forEach((h) => h(data));
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error("[WS Client] Max reconnect attempts reached");
      this.emit("error", { code: "MAX_RECONNECT_EXCEEDED", message: "Connection failed" });
      return;
    }

    const delay = Math.min(
      this.reconnectDelay * Math.pow(2, this.reconnectAttempts),
      30000
    );
    this.reconnectAttempts++;

    console.log(`[WS Client] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    setTimeout(() => this.connect(), delay);
  }

  private startPing(): void {
    this.pingInterval = setInterval(() => {
      this.send({ type: "ping", timestamp: Date.now() });
    }, 25000);
  }

  private stopPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private flushPendingMessages(): void {
    const messages = [...this.pendingMessages];
    this.pendingMessages = [];
    messages.forEach((m) => this.send(m));
  }

  disconnect(): void {
    this.stopPing();
    this.maxReconnectAttempts = 0; // Prevent reconnect
    this.ws?.close(1000, "Client disconnect");
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

// SSE Client for streaming
class SSEClient {
  private eventSource: EventSource | null = null;

  async streamCompletion(
    url: string,
    request: {
      messages: Array<{ role: string; content: string }>;
      model: string;
      temperature: number;
      conversationId: string;
    },
    handlers: {
      onChunk: (delta: string) => void;
      onComplete: (usage: TokenUsage) => void;
      onError: (error: string) => void;
    }
  ): Promise<void> {
    // Use fetch for POST + SSE (EventSource doesn't support POST)
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!response.body) throw new Error("No response body");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n\n");
      buffer = lines.pop() ?? "";

      for (const block of lines) {
        const lines2 = block.split("\n");
        let event = "message";
        let data = "";

        for (const line of lines2) {
          if (line.startsWith("event: ")) event = line.slice(7);
          if (line.startsWith("data: ")) data = line.slice(6);
        }

        if (!data) continue;

        try {
          const parsed = JSON.parse(data);
          if (event === "chunk") handlers.onChunk(parsed.delta);
          if (event === "complete") handlers.onComplete(parsed.usage);
          if (event === "error") handlers.onError(parsed.message);
        } catch {
          // Skip invalid JSON
        }
      }
    }
  }
}
```

---

## Tóm tắt Bài 10

| Technology | Use Case | Khi nào dùng |
|-----------|---------|--------------|
| WebSocket | Bidirectional, real-time | Chat, presence, collaborative |
| SSE | Server→Client streaming | LLM response streaming |
| Long Polling | Simple fallback | When WS/SSE not available |

## Bài tập thực hành

1. Implement **Room Broadcasting**: khi AI completes a response, broadcast kết quả tới tất cả clients trong cùng conversation room.
2. Xây dựng **Connection State Machine**: DISCONNECTED → CONNECTING → CONNECTED → RECONNECTING với UI indicators.
3. Implement **CRDT Sync qua WebSocket**: khi nhận `sync_update`, apply Automerge changes và notify React state.

---

*Tiếp theo: [Bài 11 — Fault Tolerance Patterns](11-fault-tolerance-patterns.md)*

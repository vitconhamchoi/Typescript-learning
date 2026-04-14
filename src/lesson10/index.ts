/**
 * Bài 10: Real-time Sync with WebSockets & SSE
 * ==============================================
 * Chạy: npm run lesson10
 *
 * Nội dung:
 *  - Type-safe WebSocket protocol (discriminated unions)
 *  - In-memory pub/sub broker
 *  - Presence / awareness system
 *  - SSE streaming simulation (LLM token stream)
 *  - Operational Transform (simple text OT)
 */

import { EventEmitter } from "eventemitter3";

// ─────────────────────────────────────────────────────────────────────────────
// 1. TYPE-SAFE WEBSOCKET PROTOCOL
// ─────────────────────────────────────────────────────────────────────────────

// Client → Server messages
type ClientMessage =
  | { type: "subscribe";   channel: string }
  | { type: "unsubscribe"; channel: string }
  | { type: "publish";     channel: string; payload: unknown }
  | { type: "presence";    status: "online" | "away" | "offline"; metadata?: Record<string, unknown> }
  | { type: "sync_request"; collection: string; since: number }
  | { type: "ping" };

// Server → Client messages
type ServerMessage =
  | { type: "subscribed";  channel: string }
  | { type: "message";     channel: string; payload: unknown; fromClientId: string }
  | { type: "presence_update"; clientId: string; status: string; metadata?: Record<string, unknown> }
  | { type: "sync_delta";  collection: string; changes: unknown[]; cursor: number }
  | { type: "error";       code: string; message: string }
  | { type: "pong";        serverTime: number };

function encodeMessage(msg: ClientMessage): string { return JSON.stringify(msg); }
function decodeMessage(raw: string): ServerMessage { return JSON.parse(raw) as ServerMessage; }

// ─────────────────────────────────────────────────────────────────────────────
// 2. IN-MEMORY PUB/SUB BROKER
// ─────────────────────────────────────────────────────────────────────────────

type ClientId = string;

interface BrokerClient {
  id: ClientId;
  send(message: ServerMessage): void;
  subscriptions: Set<string>;
}

class PubSubBroker {
  private clients   = new Map<ClientId, BrokerClient>();
  private channels  = new Map<string, Set<ClientId>>();
  private messageCount = 0;

  registerClient(client: BrokerClient): void {
    this.clients.set(client.id, client);
    console.log(`  [Broker] Client ${client.id} connected. Total: ${this.clients.size}`);
  }

  disconnectClient(clientId: ClientId): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    for (const channel of client.subscriptions) {
      this.channels.get(channel)?.delete(clientId);
    }
    this.clients.delete(clientId);
    console.log(`  [Broker] Client ${clientId} disconnected`);
  }

  subscribe(clientId: ClientId, channel: string): void {
    const client = this.clients.get(clientId);
    if (!client) throw new Error(`Unknown client: ${clientId}`);
    if (!this.channels.has(channel)) this.channels.set(channel, new Set());
    this.channels.get(channel)!.add(clientId);
    client.subscriptions.add(channel);
    client.send({ type: "subscribed", channel });
  }

  publish(fromClientId: ClientId, channel: string, payload: unknown): number {
    const subscribers = this.channels.get(channel) ?? new Set<ClientId>();
    let delivered = 0;
    for (const clientId of subscribers) {
      if (clientId === fromClientId) continue; // don't echo to sender
      const client = this.clients.get(clientId);
      if (client) { client.send({ type: "message", channel, payload, fromClientId }); delivered++; }
    }
    this.messageCount++;
    return delivered;
  }

  broadcast(message: ServerMessage): void {
    for (const client of this.clients.values()) client.send(message);
  }

  get stats() {
    return { clients: this.clients.size, channels: this.channels.size, messageCount: this.messageCount };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. PRESENCE / AWARENESS SYSTEM
// ─────────────────────────────────────────────────────────────────────────────

interface UserPresence {
  clientId: ClientId;
  userId: string;
  status: "online" | "away" | "offline";
  cursor?: { x: number; y: number };
  selection?: { from: number; to: number };
  lastSeen: number;
}

class PresenceManager {
  private presences = new Map<ClientId, UserPresence>();
  private readonly ttlMs = 30_000;

  update(presence: UserPresence): void {
    this.presences.set(presence.clientId, { ...presence, lastSeen: Date.now() });
  }

  remove(clientId: ClientId): void { this.presences.delete(clientId); }

  getActive(): UserPresence[] {
    const now = Date.now();
    const active: UserPresence[] = [];
    for (const [id, p] of this.presences) {
      if (now - p.lastSeen > this.ttlMs) { this.presences.delete(id); continue; }
      active.push(p);
    }
    return active;
  }

  get size(): number { return this.presences.size; }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. SSE STREAMING SIMULATION (LLM tokens)
// ─────────────────────────────────────────────────────────────────────────────

interface SSEEvent {
  event?: string;
  data: string;
  id?: string;
  retry?: number;
}

function formatSSE(event: SSEEvent): string {
  const lines: string[] = [];
  if (event.retry) lines.push(`retry: ${event.retry}`);
  if (event.id)    lines.push(`id: ${event.id}`);
  if (event.event) lines.push(`event: ${event.event}`);
  lines.push(`data: ${event.data}`);
  lines.push(""); // blank line
  return lines.join("\n");
}

async function* sseStream(prompt: string): AsyncGenerator<SSEEvent> {
  const tokens = `AI response to "${prompt.slice(0, 30)}": This is a streaming response.`.split(" ");
  let id = 0;
  for (const token of tokens) {
    await new Promise(r => setTimeout(r, 15));
    yield { event: "token", data: JSON.stringify({ token: token + " " }), id: String(++id) };
  }
  yield { event: "done", data: JSON.stringify({ finishReason: "stop" }), id: String(++id) };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. SIMPLE OPERATIONAL TRANSFORM (text insert/delete)
// ─────────────────────────────────────────────────────────────────────────────

type OTOperation =
  | { type: "insert"; pos: number; chars: string }
  | { type: "delete"; pos: number; count: number }
  | { type: "retain"; count: number };

function applyOT(doc: string, ops: OTOperation[]): string {
  let result = "";
  let pos = 0;
  for (const op of ops) {
    switch (op.type) {
      case "retain": result += doc.slice(pos, pos + op.count); pos += op.count; break;
      case "insert": result += op.chars; break;
      case "delete": pos += op.count; break;
    }
  }
  result += doc.slice(pos);
  return result;
}

function transformOT(opA: OTOperation[], opB: OTOperation[]): [OTOperation[], OTOperation[]] {
  // Simplified scalar position transform (production: use ot.js / ShareDB)
  let deltaA = 0, deltaB = 0;
  for (const op of opA) {
    if (op.type === "insert") deltaA += op.chars.length;
    if (op.type === "delete") deltaA -= op.count;
  }
  for (const op of opB) {
    if (op.type === "insert") deltaB += op.chars.length;
    if (op.type === "delete") deltaB -= op.count;
  }

  const adjustedB = opB.map(op => {
    if (op.type === "insert" || op.type === "delete") return { ...op, pos: op.pos + deltaA };
    return op;
  });
  const adjustedA = opA.map(op => {
    if (op.type === "insert" || op.type === "delete") return { ...op, pos: op.pos + deltaB };
    return op;
  });
  return [adjustedA, adjustedB];
}

// ─────────────────────────────────────────────────────────────────────────────
// DEMO / RUN
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n══════════════════════════════════════");
  console.log(" Bài 10: Real-time Sync WebSockets & SSE");
  console.log("══════════════════════════════════════\n");

  // ── Pub/Sub Broker ──
  console.log("[Pub/Sub Broker]");
  const broker = new PubSubBroker();
  const inbox = new Map<ClientId, ServerMessage[]>();

  function makeClient(id: ClientId): BrokerClient {
    inbox.set(id, []);
    return { id, subscriptions: new Set(), send: (msg) => inbox.get(id)!.push(msg) };
  }

  const clientA = makeClient("client_A");
  const clientB = makeClient("client_B");
  const clientC = makeClient("client_C");

  broker.registerClient(clientA);
  broker.registerClient(clientB);
  broker.registerClient(clientC);

  broker.subscribe("client_A", "notes:room_1");
  broker.subscribe("client_B", "notes:room_1");
  broker.subscribe("client_C", "notes:room_2");

  const delivered1 = broker.publish("client_A", "notes:room_1", { op: "insert", text: "Hello" });
  const delivered2 = broker.publish("client_C", "notes:room_2", { op: "insert", text: "World" });
  console.log(`  Delivered to room_1: ${delivered1}, room_2: ${delivered2}`);
  console.log(`  B inbox: ${inbox.get("client_B")?.length} messages`);
  console.log(`  C inbox: ${inbox.get("client_C")?.length} messages`);
  console.log(`  Broker stats:`, broker.stats);

  broker.disconnectClient("client_B");

  // ── Presence ──
  console.log("\n[Presence Manager]");
  const presence = new PresenceManager();
  presence.update({ clientId: "client_A", userId: "alice", status: "online", cursor: { x: 120, y: 45 }, lastSeen: Date.now() });
  presence.update({ clientId: "client_C", userId: "charlie", status: "away", lastSeen: Date.now() });
  const active = presence.getActive();
  console.log(`  Active users (${active.length}):`, active.map(p => `${p.userId}(${p.status})`).join(", "));

  // ── SSE Stream ──
  console.log("\n[SSE LLM Streaming]");
  let tokenCount = 0;
  process.stdout.write("  > ");
  for await (const event of sseStream("Explain TypeScript generics")) {
    const parsed = JSON.parse(event.data) as Record<string, string>;
    if (event.event === "token" && parsed["token"]) {
      process.stdout.write(parsed["token"]);
      tokenCount++;
    } else if (event.event === "done") {
      console.log(`\n  Stream complete. Tokens: ${tokenCount}`);
    }
    // In real HTTP: res.write(formatSSE(event))
  }

  // ── Operational Transform ──
  console.log("\n[Operational Transform]");
  let doc = "Hello World";
  const opA: OTOperation[] = [{ type: "insert", pos: 5, chars: " Beautiful" }];
  const opB: OTOperation[] = [{ type: "insert", pos: 6, chars: "TypeScript " }];

  const docA = applyOT(doc, opA);
  const docB = applyOT(doc, opB);
  console.log(`  Doc after A: "${docA}"`);
  console.log(`  Doc after B: "${docB}"`);

  // Transform B against A and apply
  const [, transformedB] = transformOT(opA, opB);
  const merged = applyOT(docA, transformedB);
  console.log(`  After OT merge: "${merged}"`);

  console.log("\n✅ Bài 10 hoàn thành!\n");
}

main().catch(console.error);

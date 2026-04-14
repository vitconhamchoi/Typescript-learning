# Bài 4: CRDTs — Conflict-Free Replicated Data Types

## Mục tiêu bài học

- Hiểu tại sao CRDTs là giải pháp tối ưu cho offline-first distributed systems
- Implement các CRDT cơ bản từ đầu bằng TypeScript
- Tích hợp Automerge và Yjs cho production use
- Áp dụng CRDTs cho AI collaborative editing và shared state

---

## 4.1 Tại Sao CRDTs?

Trong hệ thống phân tán, khi nhiều clients cùng edit data offline rồi sync lại, ta có vấn đề **conflict**. CRDTs giải quyết bằng cách đảm bảo:

1. **Convergence**: Tất cả replicas cuối cùng đến cùng state
2. **Commutativity**: Thứ tự apply operations không quan trọng
3. **Idempotency**: Apply cùng operation nhiều lần = apply một lần

```
Traditional Conflict:           CRDT (No Conflict):
User A: count = 5              User A: increment(5)   
User B: count = 3              User B: increment(3)
Sync → count = 5 hoặc 3?      Sync → increment(5) + increment(3) = 8 ✓
```

---

## 4.2 G-Counter (Grow-Only Counter)

```typescript
// G-Counter: mỗi node có counter riêng, chỉ increment
type NodeId = string;

class GCounter {
  private state: Map<NodeId, number>;

  constructor(private nodeId: NodeId, initial?: Map<NodeId, number>) {
    this.state = initial ? new Map(initial) : new Map([[nodeId, 0]]);
  }

  increment(by: number = 1): void {
    if (by < 0) throw new Error("G-Counter only supports positive increments");
    const current = this.state.get(this.nodeId) ?? 0;
    this.state.set(this.nodeId, current + by);
  }

  value(): number {
    let total = 0;
    for (const count of this.state.values()) {
      total += count;
    }
    return total;
  }

  // Merge: take max per node
  merge(other: GCounter): GCounter {
    const merged = new Map(this.state);
    for (const [nodeId, count] of other.state) {
      merged.set(nodeId, Math.max(merged.get(nodeId) ?? 0, count));
    }
    return new GCounter(this.nodeId, merged);
  }

  // For sync: serialize state
  toJSON(): Record<NodeId, number> {
    return Object.fromEntries(this.state);
  }

  static fromJSON(nodeId: NodeId, data: Record<NodeId, number>): GCounter {
    return new GCounter(nodeId, new Map(Object.entries(data)));
  }

  // Compare: happens-before relation
  happensBefore(other: GCounter): boolean {
    for (const [nodeId, count] of this.state) {
      if (count > (other.state.get(nodeId) ?? 0)) return false;
    }
    return true;
  }
}

// Use case: tracking AI token usage across devices
class TokenUsageTracker {
  private inputTokens: GCounter;
  private outputTokens: GCounter;
  private apiCalls: GCounter;

  constructor(deviceId: string) {
    this.inputTokens = new GCounter(deviceId);
    this.outputTokens = new GCounter(deviceId);
    this.apiCalls = new GCounter(deviceId);
  }

  recordAPICall(inputTokens: number, outputTokens: number): void {
    this.inputTokens.increment(inputTokens);
    this.outputTokens.increment(outputTokens);
    this.apiCalls.increment(1);
  }

  getStats() {
    return {
      totalInputTokens: this.inputTokens.value(),
      totalOutputTokens: this.outputTokens.value(),
      totalApiCalls: this.apiCalls.value(),
      totalTokens: this.inputTokens.value() + this.outputTokens.value(),
    };
  }

  merge(other: TokenUsageTracker): TokenUsageTracker {
    this.inputTokens = this.inputTokens.merge(other.inputTokens);
    this.outputTokens = this.outputTokens.merge(other.outputTokens);
    this.apiCalls = this.apiCalls.merge(other.apiCalls);
    return this;
  }
}
```

---

## 4.3 LWW-Register (Last-Write-Wins Register)

```typescript
// LWW Register với Hybrid Logical Clocks (HLC) để ordering chính xác hơn
interface HLCTimestamp {
  wallTime: number;   // Physical time (ms)
  logical: number;    // Logical counter
  nodeId: string;     // Tiebreaker
}

class HybridLogicalClock {
  private logical = 0;
  private lastWallTime = 0;

  constructor(private nodeId: string) {}

  now(): HLCTimestamp {
    const wallTime = Date.now();
    if (wallTime > this.lastWallTime) {
      this.logical = 0;
      this.lastWallTime = wallTime;
    } else {
      this.logical++;
    }
    return { wallTime: this.lastWallTime, logical: this.logical, nodeId: this.nodeId };
  }

  update(received: HLCTimestamp): HLCTimestamp {
    const wallTime = Date.now();
    const maxWall = Math.max(wallTime, received.wallTime);
    
    if (maxWall === this.lastWallTime && maxWall === received.wallTime) {
      this.logical = Math.max(this.logical, received.logical) + 1;
    } else if (maxWall === this.lastWallTime) {
      this.logical++;
    } else if (maxWall === received.wallTime) {
      this.logical = received.logical + 1;
    } else {
      this.logical = 0;
    }
    
    this.lastWallTime = maxWall;
    return { wallTime: maxWall, logical: this.logical, nodeId: this.nodeId };
  }

  static compare(a: HLCTimestamp, b: HLCTimestamp): number {
    if (a.wallTime !== b.wallTime) return a.wallTime - b.wallTime;
    if (a.logical !== b.logical) return a.logical - b.logical;
    return a.nodeId.localeCompare(b.nodeId);
  }
}

// LWW Register
class LWWRegister<T> {
  private timestamp: HLCTimestamp;
  private clock: HybridLogicalClock;

  constructor(
    private value: T,
    nodeId: string
  ) {
    this.clock = new HybridLogicalClock(nodeId);
    this.timestamp = this.clock.now();
  }

  set(value: T): void {
    this.value = value;
    this.timestamp = this.clock.now();
  }

  get(): T {
    return this.value;
  }

  merge(other: LWWRegister<T>): LWWRegister<T> {
    if (HybridLogicalClock.compare(other.timestamp, this.timestamp) > 0) {
      this.value = other.value;
      this.timestamp = this.clock.update(other.timestamp);
    }
    return this;
  }

  toJSON() {
    return { value: this.value, timestamp: this.timestamp };
  }
}

// LWW Map: map of LWW Registers
class LWWMap<V> {
  private entries: Map<string, LWWRegister<V | null>>;

  constructor(private nodeId: string) {
    this.entries = new Map();
  }

  set(key: string, value: V): void {
    if (!this.entries.has(key)) {
      this.entries.set(key, new LWWRegister<V | null>(value, this.nodeId));
    } else {
      this.entries.get(key)!.set(value);
    }
  }

  delete(key: string): void {
    if (!this.entries.has(key)) {
      this.entries.set(key, new LWWRegister<V | null>(null, this.nodeId));
    } else {
      this.entries.get(key)!.set(null);
    }
  }

  get(key: string): V | undefined {
    const reg = this.entries.get(key);
    const value = reg?.get();
    return value !== null && value !== undefined ? value : undefined;
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  entries(): Array<[string, V]> {
    const result: Array<[string, V]> = [];
    for (const [key, reg] of this.entries) {
      const value = reg.get();
      if (value !== null && value !== undefined) {
        result.push([key, value]);
      }
    }
    return result;
  }

  merge(other: LWWMap<V>): LWWMap<V> {
    for (const [key, otherReg] of other.entries) {
      if (!this.entries.has(key)) {
        this.entries.set(key, otherReg);
      } else {
        this.entries.get(key)!.merge(otherReg);
      }
    }
    return this;
  }
}
```

---

## 4.4 OR-Set (Observed-Remove Set)

OR-Set cho phép cả add và remove mà không conflict:

```typescript
// Unique tag per element per operation
interface Tag {
  nodeId: string;
  unique: string;
}

class ORSet<T> {
  // Map từ element -> set of tags (tags = evidence element được added)
  private state: Map<string, { value: T; tags: Set<string> }>;

  constructor(private nodeId: string) {
    this.state = new Map();
  }

  private elementKey(element: T): string {
    return JSON.stringify(element);
  }

  add(element: T): void {
    const key = this.elementKey(element);
    const tag = `${this.nodeId}:${crypto.randomUUID()}`;
    
    if (!this.state.has(key)) {
      this.state.set(key, { value: element, tags: new Set([tag]) });
    } else {
      this.state.get(key)!.tags.add(tag);
    }
  }

  remove(element: T): void {
    const key = this.elementKey(element);
    // Remove by clearing all tags (not the entry itself)
    // This allows re-add to work correctly
    const entry = this.state.get(key);
    if (entry) {
      entry.tags.clear();
    }
  }

  has(element: T): boolean {
    const key = this.elementKey(element);
    const entry = this.state.get(key);
    return entry !== undefined && entry.tags.size > 0;
  }

  values(): T[] {
    return Array.from(this.state.values())
      .filter((entry) => entry.tags.size > 0)
      .map((entry) => entry.value);
  }

  // Merge: union of tags
  merge(other: ORSet<T>): ORSet<T> {
    for (const [key, otherEntry] of other.state) {
      if (!this.state.has(key)) {
        this.state.set(key, {
          value: otherEntry.value,
          tags: new Set(otherEntry.tags),
        });
      } else {
        const entry = this.state.get(key)!;
        for (const tag of otherEntry.tags) {
          entry.tags.add(tag);
        }
      }
    }
    return this;
  }

  size(): number {
    return this.values().length;
  }
}

// Use case: Collaborative AI prompt library
class CollaborativePromptLibrary {
  private prompts: ORSet<{ id: string; name: string; content: string }>;

  constructor(nodeId: string) {
    this.prompts = new ORSet(nodeId);
  }

  addPrompt(id: string, name: string, content: string): void {
    this.prompts.add({ id, name, content });
  }

  removePrompt(id: string): void {
    const prompt = this.prompts.values().find((p) => p.id === id);
    if (prompt) {
      this.prompts.remove(prompt);
    }
  }

  getPrompts(): Array<{ id: string; name: string; content: string }> {
    return this.prompts.values();
  }

  merge(other: CollaborativePromptLibrary): void {
    this.prompts.merge(other.prompts);
  }
}
```

---

## 4.5 Automerge — Production CRDT Library

Automerge handles complex data structures automatically:

```typescript
import * as Automerge from "@automerge/automerge";

// Define document types
interface AIConfig {
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
  tools: string[];
  knowledgeBases: Record<string, boolean>;
  userPreferences: {
    theme: "light" | "dark";
    language: string;
    notifications: boolean;
  };
}

// Create initial document
function createAIConfig(): Automerge.Doc<AIConfig> {
  return Automerge.from<AIConfig>({
    systemPrompt: "You are a helpful assistant.",
    temperature: 0.7,
    maxTokens: 2048,
    tools: [],
    knowledgeBases: {},
    userPreferences: {
      theme: "dark",
      language: "en",
      notifications: true,
    },
  });
}

// Automerge-based collaborative config manager
class CollaborativeAIConfig {
  private doc: Automerge.Doc<AIConfig>;

  constructor(initial?: Uint8Array) {
    if (initial) {
      this.doc = Automerge.load<AIConfig>(initial);
    } else {
      this.doc = createAIConfig();
    }
  }

  updateSystemPrompt(prompt: string): Uint8Array {
    const [newDoc, changes] = Automerge.applyChanges(
      this.doc,
      Automerge.getAllChanges(
        Automerge.change(this.doc, (d) => {
          d.systemPrompt = prompt;
        })
      )
    );
    this.doc = newDoc;
    return Automerge.save(this.doc);
  }

  addTool(toolName: string): void {
    this.doc = Automerge.change(this.doc, (d) => {
      if (!d.tools.includes(toolName)) {
        d.tools.push(toolName);
      }
    });
  }

  removeTool(toolName: string): void {
    this.doc = Automerge.change(this.doc, (d) => {
      const idx = d.tools.indexOf(toolName);
      if (idx >= 0) {
        d.tools.splice(idx, 1);
      }
    });
  }

  setKnowledgeBase(name: string, enabled: boolean): void {
    this.doc = Automerge.change(this.doc, (d) => {
      d.knowledgeBases[name] = enabled;
    });
  }

  // Merge changes from another peer
  merge(remoteChanges: Uint8Array): void {
    const remoteDoc = Automerge.load<AIConfig>(remoteChanges);
    this.doc = Automerge.merge(this.doc, remoteDoc);
  }

  // Get binary for network transmission
  serialize(): Uint8Array {
    return Automerge.save(this.doc);
  }

  // Get only new changes since last sync
  getChanges(since?: Uint8Array): Uint8Array[] {
    if (!since) return Automerge.getAllChanges(this.doc);
    const sinceDoc = Automerge.load<AIConfig>(since);
    return Automerge.getChanges(sinceDoc, this.doc);
  }

  getConfig(): Readonly<AIConfig> {
    return this.doc;
  }
}
```

---

## 4.6 Yjs — Real-time Collaborative Editing cho AI

Yjs là lựa chọn tốt nhất cho collaborative text editing (shared prompts, documents):

```typescript
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { IndexeddbPersistence } from "y-indexeddb";

// Collaborative AI workspace với Yjs
class CollaborativeAIWorkspace {
  private ydoc: Y.Doc;
  private wsProvider: WebsocketProvider | null = null;
  private idbProvider: IndexeddbPersistence;
  
  // Shared types
  private sharedPrompt: Y.Text;
  private sharedConfig: Y.Map<unknown>;
  private sharedMessages: Y.Array<unknown>;
  private awareness: ReturnType<WebsocketProvider["awareness"]["getLocalState"]>;

  constructor(
    workspaceId: string,
    userId: string,
    userName: string
  ) {
    this.ydoc = new Y.Doc();
    
    // Get shared types
    this.sharedPrompt = this.ydoc.getText("systemPrompt");
    this.sharedConfig = this.ydoc.getMap("config");
    this.sharedMessages = this.ydoc.getArray("messages");

    // Local persistence (offline)
    this.idbProvider = new IndexeddbPersistence(
      `workspace:${workspaceId}`,
      this.ydoc
    );

    this.idbProvider.on("synced", () => {
      console.log("Content loaded from IndexedDB");
    });
  }

  connectToRoom(serverUrl: string, workspaceId: string): void {
    this.wsProvider = new WebsocketProvider(
      serverUrl,
      workspaceId,
      this.ydoc,
      {
        connect: true,
        resyncInterval: 10000,
      }
    );

    this.wsProvider.on("status", (event: { status: string }) => {
      console.log("Connection status:", event.status);
    });
  }

  // Type-safe text operations
  insertText(index: number, text: string): void {
    this.sharedPrompt.insert(index, text);
  }

  deleteText(index: number, length: number): void {
    this.sharedPrompt.delete(index, length);
  }

  getText(): string {
    return this.sharedPrompt.toString();
  }

  // Config operations
  setConfig(key: string, value: unknown): void {
    this.sharedConfig.set(key, value);
  }

  getConfig(key: string): unknown {
    return this.sharedConfig.get(key);
  }

  // Observe changes
  onTextChange(callback: (delta: Y.YTextEvent) => void): () => void {
    this.sharedPrompt.observe(callback);
    return () => this.sharedPrompt.unobserve(callback);
  }

  onConfigChange(callback: (event: Y.YMapEvent<unknown>) => void): () => void {
    this.sharedConfig.observe(callback);
    return () => this.sharedConfig.unobserve(callback);
  }

  // Undo/Redo
  createUndoManager(): Y.UndoManager {
    return new Y.UndoManager([this.sharedPrompt, this.sharedConfig]);
  }

  destroy(): void {
    this.wsProvider?.destroy();
    this.idbProvider.destroy();
    this.ydoc.destroy();
  }
}
```

---

## Tóm tắt Bài 4

| CRDT Type | Hỗ trợ Operations | Use Case trong AI |
|-----------|-------------------|-------------------|
| G-Counter | Increment only | Token usage tracking, API call counts |
| LWW-Register | Set with timestamp | User preferences, model selection |
| LWW-Map | Set/Delete with timestamp | Feature flags, configuration |
| OR-Set | Add/Remove | Shared prompt libraries, tool lists |
| Automerge | Complex structures | AI config sharing across devices |
| Yjs | Text + structures + presence | Collaborative prompt editing |

## Bài tập thực hành

1. Implement **PN-Counter** (Positive-Negative Counter) cho tracking AI "rating" (up/down votes trên responses).
2. Dùng Yjs để build **Collaborative Prompt Editor**: 2 users cùng edit prompt, thay đổi sync real-time và offline.
3. Implement **CRDT-based AI History**: shared conversation history giữa nhiều devices của cùng user, dùng Automerge.

---

*Tiếp theo: [Bài 5 — Service Workers & Background Sync](05-service-workers-background-sync.md)*

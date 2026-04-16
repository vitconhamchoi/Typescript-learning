/**
 * Bài 4: CRDTs — Conflict-Free Replicated Data Types
 * ====================================================
 * Chạy: npm run lesson04
 *
 * Nội dung:
 *  - G-Counter (grow-only counter)
 *  - PN-Counter (positive-negative counter)
 *  - LWW-Register (last-write-wins register)
 *  - OR-Set (observed-remove set)
 *  - LWW-Map (document / element map)
 *  - Token usage tracker (G-Counter use case)
 *  - Collaborative prompt library (OR-Set use case)
 *  - Merge / convergence guarantees
 */

// ─────────────────────────────────────────────────────────────────────────────
// 0. SHARED TYPES
// ─────────────────────────────────────────────────────────────────────────────

type NodeId = string;
type HLC   = { wallTime: number; logical: number; nodeId: NodeId }; // Hybrid Logical Clock

function hlcNow(nodeId: NodeId, lastKnown?: HLC): HLC {
  const wallTime = Date.now();
  if (!lastKnown || wallTime > lastKnown.wallTime) {
    return { wallTime, logical: 0, nodeId };
  }
  return { wallTime: lastKnown.wallTime, logical: lastKnown.logical + 1, nodeId };
}

/** Update local HLC when receiving a remote timestamp */
function hlcUpdate(nodeId: NodeId, local: HLC, remote: HLC): HLC {
  const wallTime = Date.now();
  const maxWall = Math.max(wallTime, local.wallTime, remote.wallTime);

  let logical: number;
  if (maxWall === local.wallTime && maxWall === remote.wallTime) {
    logical = Math.max(local.logical, remote.logical) + 1;
  } else if (maxWall === local.wallTime) {
    logical = local.logical + 1;
  } else if (maxWall === remote.wallTime) {
    logical = remote.logical + 1;
  } else {
    logical = 0;
  }

  return { wallTime: maxWall, logical, nodeId };
}

function hlcCompare(a: HLC, b: HLC): number {
  if (a.wallTime !== b.wallTime) return a.wallTime - b.wallTime;
  if (a.logical   !== b.logical)  return a.logical   - b.logical;
  return a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. G-COUNTER  (grow-only, distributed counter)
// ─────────────────────────────────────────────────────────────────────────────

class GCounter {
  private counts: Map<NodeId, number>;

  constructor(readonly nodeId: NodeId, initial?: Record<NodeId, number>) {
    this.counts = new Map(Object.entries(initial ?? {}));
  }

  increment(by = 1): void {
    this.counts.set(this.nodeId, (this.counts.get(this.nodeId) ?? 0) + by);
  }

  value(): number {
    let total = 0;
    for (const v of this.counts.values()) total += v;
    return total;
  }

  merge(other: GCounter): void {
    for (const [node, count] of other.counts) {
      this.counts.set(node, Math.max(this.counts.get(node) ?? 0, count));
    }
  }

  /** Check if this counter strictly happens-before another (all entries ≤ and at least one <) */
  happensBefore(other: GCounter): boolean {
    let strictlyLess = false;
    for (const [node, count] of this.counts) {
      const otherCount = other.counts.get(node) ?? 0;
      if (count > otherCount) return false;
      if (count < otherCount) strictlyLess = true;
    }
    // Also check nodes only in other
    for (const [node] of other.counts) {
      if (!this.counts.has(node)) strictlyLess = true;
    }
    return strictlyLess;
  }

  toJSON(): Record<NodeId, number> {
    return Object.fromEntries(this.counts);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. PN-COUNTER  (positive + negative = net counter)
// ─────────────────────────────────────────────────────────────────────────────

class PNCounter {
  private P: GCounter;
  private N: GCounter;

  constructor(readonly nodeId: NodeId) {
    this.P = new GCounter(nodeId);
    this.N = new GCounter(nodeId);
  }

  increment(by = 1): void { this.P.increment(by); }
  decrement(by = 1): void { this.N.increment(by); }
  value(): number          { return this.P.value() - this.N.value(); }

  merge(other: PNCounter): void {
    this.P.merge(other.P);
    this.N.merge(other.N);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. LWW-REGISTER  (last-write-wins using HLC)
// ─────────────────────────────────────────────────────────────────────────────

interface LWWEntry<T> {
  value: T | null;
  timestamp: HLC;
}

class LWWRegister<T> {
  private _entry: LWWEntry<T>;

  constructor(readonly nodeId: NodeId, initialValue?: T) {
    this._entry = {
      value: initialValue ?? null,
      timestamp: hlcNow(nodeId),
    };
  }

  get value(): T | null { return this._entry.value; }

  set(value: T): void {
    this._entry = { value, timestamp: hlcNow(this.nodeId, this._entry.timestamp) };
  }

  merge(other: LWWRegister<T>): void {
    if (hlcCompare(other._entry.timestamp, this._entry.timestamp) > 0) {
      this._entry = { ...other._entry };
    }
  }

  toJSON(): LWWEntry<T> { return { ...this._entry }; }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. OR-SET  (observed-remove set — concurrent add+remove is deterministic)
// ─────────────────────────────────────────────────────────────────────────────

interface ORSetEntry<T> {
  value: T;
  uid: string;   // unique tag per add
  nodeId: NodeId;
}

class ORSet<T> {
  private added   = new Map<string, ORSetEntry<T>>(); // uid → entry
  private removed = new Set<string>();                // uid tombstones

  constructor(readonly nodeId: NodeId) {}

  add(value: T): void {
    const uid = `${this.nodeId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    this.added.set(uid, { value, uid, nodeId: this.nodeId });
  }

  remove(value: T): void {
    for (const [uid, entry] of this.added) {
      if (JSON.stringify(entry.value) === JSON.stringify(value)) {
        this.removed.add(uid);
      }
    }
  }

  has(value: T): boolean {
    for (const [uid, entry] of this.added) {
      if (!this.removed.has(uid) && JSON.stringify(entry.value) === JSON.stringify(value)) {
        return true;
      }
    }
    return false;
  }

  values(): T[] {
    const result: T[] = [];
    for (const [uid, entry] of this.added) {
      if (!this.removed.has(uid)) result.push(entry.value);
    }
    return result;
  }

  merge(other: ORSet<T>): void {
    for (const [uid, entry] of other.added) {
      if (!this.added.has(uid)) this.added.set(uid, entry);
    }
    for (const uid of other.removed) {
      this.removed.add(uid);
    }
  }

  size(): number {
    return this.values().length;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. LWW-MAP  (document CRDT — field-level last-write-wins)
// ─────────────────────────────────────────────────────────────────────────────

type LWWMapState<T> = { [K in keyof T]: LWWEntry<T[K]> };

class LWWMap<T extends Record<string, unknown>> {
  private fields: Partial<LWWMapState<T>> = {};

  constructor(readonly nodeId: NodeId) {}

  set<K extends keyof T>(key: K, value: T[K]): void {
    const prev = this.fields[key];
    this.fields[key] = {
      value,
      timestamp: hlcNow(this.nodeId, prev?.timestamp),
    } as LWWMapState<T>[K];
  }

  get<K extends keyof T>(key: K): T[K] | null {
    return (this.fields[key]?.value ?? null) as T[K] | null;
  }

  merge(other: LWWMap<T>): void {
    for (const key of Object.keys(other.fields) as (keyof T)[]) {
      const remote = other.fields[key];
      const local  = this.fields[key];
      if (!remote) continue;
      if (!local || hlcCompare(remote.timestamp, local.timestamp) > 0) {
        this.fields[key] = { ...remote } as LWWMapState<T>[typeof key];
      }
    }
  }

  toObject(): Partial<T> {
    const result: Partial<T> = {};
    for (const [k, entry] of Object.entries(this.fields) as [keyof T, LWWEntry<unknown>][]) {
      result[k] = entry.value as T[typeof k];
    }
    return result;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. TOKEN USAGE TRACKER  (G-Counter use case for AI apps)
// ─────────────────────────────────────────────────────────────────────────────

class TokenUsageTracker {
  private inputTokens: GCounter;
  private outputTokens: GCounter;
  private apiCalls: GCounter;

  constructor(private deviceId: string) {
    this.inputTokens = new GCounter(deviceId);
    this.outputTokens = new GCounter(deviceId);
    this.apiCalls = new GCounter(deviceId);
  }

  recordAPICall(input: number, output: number): void {
    this.inputTokens.increment(input);
    this.outputTokens.increment(output);
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

  merge(other: TokenUsageTracker): void {
    this.inputTokens.merge(other.inputTokens);
    this.outputTokens.merge(other.outputTokens);
    this.apiCalls.merge(other.apiCalls);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. COLLABORATIVE PROMPT LIBRARY  (OR-Set use case for AI apps)
// ─────────────────────────────────────────────────────────────────────────────

interface Prompt {
  id: string;
  name: string;
  content: string;
}

class CollaborativePromptLibrary {
  private prompts: ORSet<Prompt>;

  constructor(nodeId: string) {
    this.prompts = new ORSet(nodeId);
  }

  addPrompt(id: string, name: string, content: string): void {
    this.prompts.add({ id, name, content });
  }

  removePrompt(id: string): void {
    const prompt = this.prompts.values().find(p => p.id === id);
    if (prompt) {
      this.prompts.remove(prompt);
    }
  }

  getPrompts(): Prompt[] {
    return this.prompts.values();
  }

  merge(other: CollaborativePromptLibrary): void {
    this.prompts.merge(other.prompts);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DEMO / RUN
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n══════════════════════════════════════");
  console.log(" Bài 4: CRDTs — Conflict-Free Data");
  console.log("══════════════════════════════════════\n");

  // ── G-Counter ──
  console.log("[G-Counter]");
  const gcA = new GCounter("nodeA");
  const gcB = new GCounter("nodeB");
  gcA.increment(5); gcB.increment(3); gcA.increment(2);
  console.log(`  A before merge: ${gcA.value()} (expect 7)`);
  console.log(`  B before merge: ${gcB.value()} (expect 3)`);
  console.log(`  A happensBefore B: ${gcA.happensBefore(gcB)}`);
  gcA.merge(gcB);
  console.log(`  After merge: ${gcA.value()} (expect 10)`);

  // ── PN-Counter ──
  console.log("\n[PN-Counter]");
  const pnA = new PNCounter("nodeA");
  const pnB = new PNCounter("nodeB");
  pnA.increment(10); pnB.decrement(3);
  pnA.merge(pnB);
  console.log(`  Net votes: ${pnA.value()} (expect 7)`);

  // ── LWW-Register ──
  console.log("\n[LWW-Register]");
  const regA = new LWWRegister<string>("nodeA", "offline");
  const regB = new LWWRegister<string>("nodeB", "offline");
  regA.set("online");
  await new Promise(r => setTimeout(r, 5));
  regB.set("busy");
  regA.merge(regB);
  console.log(`  Status after merge: "${regA.value}" (expect "busy")`);

  // ── HLC Update ──
  console.log("\n[HLC Update — receiving remote timestamps]");
  const localHLC = hlcNow("nodeA");
  const remoteHLC = hlcNow("nodeB");
  const updatedHLC = hlcUpdate("nodeA", localHLC, remoteHLC);
  console.log(`  Local:   wall=${localHLC.wallTime} logical=${localHLC.logical}`);
  console.log(`  Remote:  wall=${remoteHLC.wallTime} logical=${remoteHLC.logical}`);
  console.log(`  Updated: wall=${updatedHLC.wallTime} logical=${updatedHLC.logical}`);

  // ── OR-Set ──
  console.log("\n[OR-Set]");
  const setA = new ORSet<string>("nodeA");
  const setB = new ORSet<string>("nodeB");
  setA.add("react"); setA.add("typescript");
  setB.add("typescript"); // concurrent add on B
  setA.remove("typescript"); // A removes...
  // Merge: B's add happened concurrently, so "typescript" survives
  setA.merge(setB);
  console.log(`  Values: [${setA.values().join(", ")}]`);
  console.log(`  Has 'typescript': ${setA.has("typescript")}`);
  console.log(`  Has 'react': ${setA.has("react")}`);

  // ── LWW-Map: collaborative document ──
  console.log("\n[LWW-Map — Collaborative Doc]");
  type Doc = { title: string; body: string; author: string };
  const docA = new LWWMap<Doc>("nodeA");
  const docB = new LWWMap<Doc>("nodeB");
  docA.set("title", "Draft"); docA.set("author", "Alice");
  await new Promise(r => setTimeout(r, 2));
  docB.set("title", "Final Draft"); docB.set("body", "Hello World");
  docA.merge(docB);
  console.log("  Merged doc:", docA.toObject());

  // ── Token Usage Tracker (G-Counter use case) ──
  console.log("\n[Token Usage Tracker — G-Counter Use Case]");
  const laptop = new TokenUsageTracker("laptop");
  const phone = new TokenUsageTracker("phone");
  laptop.recordAPICall(500, 200);
  laptop.recordAPICall(300, 150);
  phone.recordAPICall(100, 50);
  console.log(`  Laptop stats:`, laptop.getStats());
  console.log(`  Phone stats:`, phone.getStats());
  laptop.merge(phone);
  console.log(`  After merge:`, laptop.getStats());

  // ── Collaborative Prompt Library (OR-Set use case) ──
  console.log("\n[Collaborative Prompt Library — OR-Set Use Case]");
  const aliceLib = new CollaborativePromptLibrary("alice");
  const bobLib = new CollaborativePromptLibrary("bob");
  aliceLib.addPrompt("p1", "Code Review", "Review this code for bugs...");
  aliceLib.addPrompt("p2", "Summarize", "Summarize the following...");
  bobLib.addPrompt("p3", "Translate", "Translate to Vietnamese...");
  aliceLib.merge(bobLib);
  console.log(`  Alice's library after merge:`);
  aliceLib.getPrompts().forEach(p => console.log(`    [${p.id}] ${p.name}`));

  // Remove and verify
  aliceLib.removePrompt("p2");
  console.log(`  After removing 'Summarize': ${aliceLib.getPrompts().length} prompts`);

  console.log("\n✅ Bài 4 hoàn thành!\n");
}

main().catch(console.error);

export {};

/**
 * Bài 6: Distributed Systems Fundamentals
 * ==========================================
 * Chạy: npm run lesson06
 *
 * Nội dung:
 *  - CAP Theorem — configurable consistency (strong, eventual, bounded-staleness)
 *  - Vector Clocks (causality tracking)
 *  - Causal Event Log
 *  - Consistent Hashing (node routing) + AI Workload Router
 *  - Merkle Tree (anti-entropy / diff detection)
 *  - Gossip protocol simulation
 *  - Distributed Lock (TTL-based CAS)
 *  - Leader Election
 */

import * as crypto from "crypto";

// ─────────────────────────────────────────────────────────────────────────────
// 1. VECTOR CLOCKS
// ─────────────────────────────────────────────────────────────────────────────

type VectorClock = Map<string, number>; // nodeId → counter

function vcIncrement(vc: VectorClock, nodeId: string): VectorClock {
  const next = new Map(vc);
  next.set(nodeId, (next.get(nodeId) ?? 0) + 1);
  return next;
}

function vcMerge(a: VectorClock, b: VectorClock): VectorClock {
  const merged = new Map(a);
  for (const [node, tick] of b) {
    merged.set(node, Math.max(merged.get(node) ?? 0, tick));
  }
  return merged;
}

type CausalOrder = "before" | "after" | "concurrent" | "equal";

function vcCompare(a: VectorClock, b: VectorClock): CausalOrder {
  const allNodes = new Set([...a.keys(), ...b.keys()]);
  let aLess = false, bLess = false;
  for (const node of allNodes) {
    const av = a.get(node) ?? 0;
    const bv = b.get(node) ?? 0;
    if (av < bv) aLess = true;
    if (bv < av) bLess = true;
  }
  if (!aLess && !bLess) return "equal";
  if (aLess  && !bLess) return "before";
  if (!aLess && bLess)  return "after";
  return "concurrent";
}

function vcToString(vc: VectorClock): string {
  return `{${[...vc.entries()].map(([k, v]) => `${k}:${v}`).join(", ")}}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. CAUSAL EVENT LOG
// ─────────────────────────────────────────────────────────────────────────────

interface CausalEvent {
  id: string;
  type: "message_sent" | "config_updated" | "session_started";
  payload: Record<string, unknown>;
  clock: VectorClock;
  nodeId: string;
}

class CausalEventLog {
  private events: CausalEvent[] = [];
  private clock: VectorClock = new Map();

  constructor(private nodeId: string) {}

  append(type: CausalEvent["type"], payload: Record<string, unknown>): CausalEvent {
    this.clock = vcIncrement(this.clock, this.nodeId);
    const event: CausalEvent = {
      id: `${this.nodeId}_${this.events.length}`,
      type,
      payload,
      clock: new Map(this.clock),
      nodeId: this.nodeId,
    };
    this.events.push(event);
    return event;
  }

  receive(event: CausalEvent): void {
    this.clock = vcMerge(this.clock, event.clock);
    this.events.push(event);
    this.events.sort((a, b) => {
      const order = vcCompare(a.clock, b.clock);
      return order === "before" ? -1 : order === "after" ? 1 : 0;
    });
  }

  getHistory(): CausalEvent[] { return [...this.events]; }
  getClock(): VectorClock { return new Map(this.clock); }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. CAP-AWARE DISTRIBUTED CACHE
// ─────────────────────────────────────────────────────────────────────────────

type ConsistencyLevel = "strong" | "eventual" | "bounded-staleness";

interface CacheConfig {
  consistency: ConsistencyLevel;
  maxStalenessMs?: number;
  replicationFactor: number;
}

interface Versioned<T> {
  value: T;
  version: number;
  updatedAt: number;
}

class CacheNode<T> {
  private store = new Map<string, Versioned<T>>();

  get(key: string): Versioned<T> | null {
    return this.store.get(key) ?? null;
  }

  set(key: string, value: T, version: number): void {
    this.store.set(key, { value, version, updatedAt: Date.now() });
  }
}

class DistributedCache<T> {
  private nodes: CacheNode<T>[] = [];
  private config: CacheConfig;

  constructor(config: CacheConfig) {
    this.config = config;
    for (let i = 0; i < config.replicationFactor; i++) {
      this.nodes.push(new CacheNode<T>());
    }
  }

  write(key: string, value: T, version: number): void {
    switch (this.config.consistency) {
      case "strong": {
        const quorum = Math.floor(this.nodes.length / 2) + 1;
        for (let i = 0; i < quorum; i++) this.nodes[i]!.set(key, value, version);
        break;
      }
      case "eventual": {
        this.nodes[0]!.set(key, value, version);
        // Propagate asynchronously (simulated: write all)
        for (let i = 1; i < this.nodes.length; i++) this.nodes[i]!.set(key, value, version);
        break;
      }
      case "bounded-staleness": {
        const quorum = Math.floor(this.nodes.length / 2) + 1;
        for (let i = 0; i < quorum; i++) this.nodes[i]!.set(key, value, version);
        break;
      }
    }
  }

  read(key: string): { value: T | null; source: string } {
    switch (this.config.consistency) {
      case "strong": {
        const quorum = Math.floor(this.nodes.length / 2) + 1;
        let best: Versioned<T> | null = null;
        for (let i = 0; i < quorum; i++) {
          const entry = this.nodes[i]!.get(key);
          if (entry && (!best || entry.version > best.version)) best = entry;
        }
        return { value: best?.value ?? null, source: "quorum" };
      }
      case "eventual": {
        const entry = this.nodes[0]!.get(key);
        return { value: entry?.value ?? null, source: "single-node" };
      }
      case "bounded-staleness": {
        const entry = this.nodes[0]!.get(key);
        if (entry && (Date.now() - entry.updatedAt) > (this.config.maxStalenessMs ?? 5000)) {
          // Too stale, fall back to quorum
          let best: Versioned<T> | null = null;
          for (const node of this.nodes) {
            const e = node.get(key);
            if (e && (!best || e.version > best.version)) best = e;
          }
          return { value: best?.value ?? null, source: "quorum-fallback" };
        }
        return { value: entry?.value ?? null, source: "single-node" };
      }
    }
  }

  getNodeCount(): number { return this.nodes.length; }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. CONSISTENT HASHING
// ─────────────────────────────────────────────────────────────────────────────

function fnv1a(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash * 16777619) >>> 0;
  }
  return hash;
}

interface VirtualNode {
  nodeId: string;
  virtualIndex: number;
  hash: number;
}

class ConsistentHashRing {
  private ring: VirtualNode[] = [];
  private readonly replicas: number;

  constructor(replicas = 150) { this.replicas = replicas; }

  addNode(nodeId: string): void {
    for (let i = 0; i < this.replicas; i++) {
      const hash = fnv1a(`${nodeId}:${i}`);
      this.ring.push({ nodeId, virtualIndex: i, hash });
    }
    this.ring.sort((a, b) => a.hash - b.hash);
  }

  removeNode(nodeId: string): void {
    this.ring = this.ring.filter(n => n.nodeId !== nodeId);
  }

  getNode(key: string): string | null {
    if (this.ring.length === 0) return null;
    const keyHash = fnv1a(key);
    const idx = this.ring.findIndex(n => n.hash >= keyHash);
    const vnode = idx === -1 ? this.ring[0] : this.ring[idx];
    return vnode?.nodeId ?? null;
  }

  getNodes(key: string, n: number): string[] {
    if (this.ring.length === 0) return [];
    const keyHash = fnv1a(key);
    let idx = this.ring.findIndex(n => n.hash >= keyHash);
    if (idx === -1) idx = 0;
    const seen = new Set<string>();
    const result: string[] = [];
    for (let i = 0; i < this.ring.length && result.length < n; i++) {
      const vnode = this.ring[(idx + i) % this.ring.length]!;
      if (!seen.has(vnode.nodeId)) { seen.add(vnode.nodeId); result.push(vnode.nodeId); }
    }
    return result;
  }

  distribution(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const vn of this.ring) counts[vn.nodeId] = (counts[vn.nodeId] ?? 0) + 1;
    return counts;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. AI WORKLOAD ROUTER (uses consistent hashing)
// ─────────────────────────────────────────────────────────────────────────────

interface ModelRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
}

interface ModelResponse {
  content: string;
  usage: { promptTokens: number; completionTokens: number };
  serverId: string;
}

class MockModelServer {
  constructor(
    readonly serverId: string,
    private shouldFail = false,
  ) {}

  async process(request: ModelRequest): Promise<ModelResponse> {
    if (this.shouldFail) throw new Error(`Server ${this.serverId} is down`);
    return {
      content: `Response from ${this.serverId} for model ${request.model}`,
      usage: { promptTokens: 10, completionTokens: 20 },
      serverId: this.serverId,
    };
  }
}

class AIWorkloadRouter {
  private ring = new ConsistentHashRing(100);
  private servers = new Map<string, MockModelServer>();

  registerServer(server: MockModelServer): void {
    this.servers.set(server.serverId, server);
    this.ring.addNode(server.serverId);
  }

  deregisterServer(serverId: string): void {
    this.servers.delete(serverId);
    this.ring.removeNode(serverId);
  }

  async route(conversationId: string, request: ModelRequest): Promise<ModelResponse> {
    const candidates = this.ring.getNodes(conversationId, 3);
    for (const serverId of candidates) {
      const server = this.servers.get(serverId);
      if (!server) continue;
      try {
        return await server.process(request);
      } catch {
        continue; // failover
      }
    }
    throw new Error("All servers failed");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. MERKLE TREE
// ─────────────────────────────────────────────────────────────────────────────

function sha256(data: string): string {
  return crypto.createHash("sha256").update(data).digest("hex").slice(0, 16);
}

interface MerkleNode {
  hash: string;
  left:  MerkleNode | null;
  right: MerkleNode | null;
  isLeaf: boolean;
  key?: string;
}

function buildMerkleTree(entries: { key: string; value: string }[]): MerkleNode | null {
  if (entries.length === 0) return null;

  let leaves: MerkleNode[] = entries.map(e => ({
    hash: sha256(`${e.key}:${e.value}`),
    left: null, right: null,
    isLeaf: true,
    key: e.key,
  }));

  while (leaves.length > 1) {
    const nextLevel: MerkleNode[] = [];
    for (let i = 0; i < leaves.length; i += 2) {
      const left  = leaves[i]!;
      const right = leaves[i + 1] ?? left;
      nextLevel.push({
        hash: sha256(left.hash + right.hash),
        left, right,
        isLeaf: false,
      });
    }
    leaves = nextLevel;
  }
  return leaves[0] ?? null;
}

function diffMerkleTrees(a: MerkleNode | null, b: MerkleNode | null, path = ""): string[] {
  if (!a && !b) return [];
  if (!a || !b) return [path || "root"];
  if (a.hash === b.hash) return [];
  if (a.isLeaf && b.isLeaf) return [a.key ?? path];
  return [
    ...diffMerkleTrees(a.left,  b.left,  `${path}L`),
    ...diffMerkleTrees(a.right, b.right, `${path}R`),
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. CONVERSATION SYNC PROTOCOL (uses Merkle Tree)
// ─────────────────────────────────────────────────────────────────────────────

class ConversationSyncProtocol {
  private tree: MerkleNode | null;
  private conversations: Map<string, string>;

  constructor(conversations: Map<string, string>) {
    this.conversations = conversations;
    const sortedIds = [...conversations.keys()].sort();
    this.tree = buildMerkleTree(
      sortedIds.map(id => ({ key: id, value: conversations.get(id)! }))
    );
  }

  getMerkleRoot(): string | null {
    return this.tree?.hash ?? null;
  }

  syncWith(remote: ConversationSyncProtocol): { toSend: string[]; matching: boolean } {
    if (this.getMerkleRoot() === remote.getMerkleRoot()) {
      return { toSend: [], matching: true };
    }
    const diffs = diffMerkleTrees(this.tree, remote.tree);
    const toSend = diffs.filter(k => this.conversations.has(k));
    return { toSend, matching: false };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. GOSSIP PROTOCOL SIMULATION
// ─────────────────────────────────────────────────────────────────────────────

interface GossipMessage {
  key: string;
  value: unknown;
  version: number;
  originNodeId: string;
}

interface GossipState {
  [key: string]: GossipMessage;
}

class GossipNode {
  private state: GossipState = {};
  private readonly peers: GossipNode[] = [];

  constructor(readonly nodeId: string) {}

  addPeer(node: GossipNode): void { this.peers.push(node); }

  set(key: string, value: unknown): void {
    const existing = this.state[key];
    const version  = (existing?.version ?? 0) + 1;
    this.state[key] = { key, value, version, originNodeId: this.nodeId };
  }

  get(key: string): unknown { return this.state[key]?.value; }

  gossipOnce(): void {
    if (this.peers.length === 0) return;
    const peer = this.peers[Math.floor(Math.random() * this.peers.length)]!;
    const digest: Record<string, number> = {};
    for (const [k, msg] of Object.entries(this.state)) digest[k] = msg.version;

    const updates = peer.handleDigest(digest);
    for (const msg of updates) {
      const existing = this.state[msg.key];
      if (!existing || msg.version > existing.version) {
        this.state[msg.key] = msg;
      }
    }
  }

  handleDigest(digest: Record<string, number>): GossipMessage[] {
    const updates: GossipMessage[] = [];
    for (const [key, msg] of Object.entries(this.state)) {
      const remoteVersion = digest[key] ?? 0;
      if (msg.version > remoteVersion) updates.push(msg);
    }
    return updates;
  }

  snapshot(): GossipState { return { ...this.state }; }
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. DISTRIBUTED LOCK (TTL-based CAS)
// ─────────────────────────────────────────────────────────────────────────────

class InMemoryLockStore {
  private locks = new Map<string, { value: string; expiresAt: number }>();

  setNX(key: string, value: string, ttlMs: number): boolean {
    this.cleanup();
    if (this.locks.has(key)) return false;
    this.locks.set(key, { value, expiresAt: Date.now() + ttlMs });
    return true;
  }

  get(key: string): string | null {
    this.cleanup();
    return this.locks.get(key)?.value ?? null;
  }

  del(key: string): void {
    this.locks.delete(key);
  }

  extend(key: string, ttlMs: number, expectedValue: string): boolean {
    this.cleanup();
    const entry = this.locks.get(key);
    if (!entry || entry.value !== expectedValue) return false;
    entry.expiresAt = Date.now() + ttlMs;
    return true;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.locks) {
      if (entry.expiresAt <= now) this.locks.delete(key);
    }
  }
}

class DistributedLock {
  private readonly ownerId: string;

  constructor(
    private store: InMemoryLockStore,
    private lockKey: string,
  ) {
    this.ownerId = `owner_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  }

  acquire(ttlMs = 30000, retries = 3): boolean {
    for (let i = 0; i < retries; i++) {
      if (this.store.setNX(this.lockKey, this.ownerId, ttlMs)) return true;
    }
    return false;
  }

  release(): void {
    const current = this.store.get(this.lockKey);
    if (current === this.ownerId) {
      this.store.del(this.lockKey);
    }
  }

  extend(additionalMs: number): boolean {
    return this.store.extend(this.lockKey, additionalMs, this.ownerId);
  }

  withLock<T>(fn: () => T, ttlMs = 30000): T {
    const acquired = this.acquire(ttlMs);
    if (!acquired) throw new Error(`Could not acquire lock: ${this.lockKey}`);
    try {
      return fn();
    } finally {
      this.release();
    }
  }

  getOwnerId(): string { return this.ownerId; }
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. LEADER ELECTION
// ─────────────────────────────────────────────────────────────────────────────

class LeaderElection {
  private _isLeader = false;

  constructor(
    private lock: DistributedLock,
    readonly nodeId: string,
  ) {}

  attemptLeadership(): void {
    if (this._isLeader) {
      const extended = this.lock.extend(15000);
      if (!extended) {
        this._isLeader = false;
        console.log(`  [Leader] ${this.nodeId} lost leadership`);
      }
    } else {
      const acquired = this.lock.acquire(15000, 1);
      if (acquired) {
        this._isLeader = true;
        console.log(`  [Leader] ${this.nodeId} became leader`);
      }
    }
  }

  isLeader(): boolean { return this._isLeader; }

  stepDown(): void {
    if (this._isLeader) {
      this.lock.release();
      this._isLeader = false;
      console.log(`  [Leader] ${this.nodeId} stepped down`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DEMO / RUN
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n══════════════════════════════════════");
  console.log(" Bài 6: Distributed Systems Fundamentals");
  console.log("══════════════════════════════════════\n");

  // ── Vector Clocks ──
  console.log("[1. Vector Clocks]");
  let vcA: VectorClock = new Map();
  let vcB: VectorClock = new Map();

  vcA = vcIncrement(vcA, "A");
  vcA = vcIncrement(vcA, "A");
  vcB = vcIncrement(vcB, "B");

  console.log(`  A: ${vcToString(vcA)}`);
  console.log(`  B: ${vcToString(vcB)}`);
  console.log(`  A vs B: ${vcCompare(vcA, vcB)}`); // concurrent

  const merged = vcMerge(vcA, vcB);
  const vcA2   = vcIncrement(merged, "A");
  console.log(`  After A merges B and increments: ${vcToString(vcA2)}`);
  console.log(`  vcB vs vcA2: ${vcCompare(vcB, vcA2)}`); // before

  // ── Causal Event Log ──
  console.log("\n[2. Causal Event Log]");
  const logA = new CausalEventLog("nodeA");
  const logB = new CausalEventLog("nodeB");

  const e1 = logA.append("session_started", { user: "Alice" });
  console.log(`  nodeA appended: ${e1.type} clock=${vcToString(e1.clock)}`);

  const e2 = logB.append("config_updated", { theme: "dark" });
  console.log(`  nodeB appended: ${e2.type} clock=${vcToString(e2.clock)}`);

  logA.receive(e2);
  const e3 = logA.append("message_sent", { text: "Hello" });
  console.log(`  nodeA after receiving B's event: ${e3.type} clock=${vcToString(e3.clock)}`);
  console.log(`  nodeA event history length: ${logA.getHistory().length}`);

  // ── CAP-Aware Distributed Cache ──
  console.log("\n[3. CAP-Aware Distributed Cache]");
  const strongCache = new DistributedCache<string>({
    consistency: "strong",
    replicationFactor: 3,
  });
  strongCache.write("user:1", "Alice", 1);
  const r1 = strongCache.read("user:1");
  console.log(`  Strong read: value="${r1.value}" source=${r1.source}`);

  const eventualCache = new DistributedCache<string>({
    consistency: "eventual",
    replicationFactor: 3,
  });
  eventualCache.write("user:2", "Bob", 1);
  const r2 = eventualCache.read("user:2");
  console.log(`  Eventual read: value="${r2.value}" source=${r2.source}`);

  const boundedCache = new DistributedCache<string>({
    consistency: "bounded-staleness",
    maxStalenessMs: 5000,
    replicationFactor: 3,
  });
  boundedCache.write("user:3", "Charlie", 1);
  const r3 = boundedCache.read("user:3");
  console.log(`  Bounded-staleness read: value="${r3.value}" source=${r3.source}`);

  // ── Consistent Hashing ──
  console.log("\n[4. Consistent Hashing]");
  const ring = new ConsistentHashRing(100);
  ["node-1", "node-2", "node-3", "node-4"].forEach(n => ring.addNode(n));

  const keys = ["user:alice", "user:bob", "session:xyz", "cache:home", "cache:profile"];
  keys.forEach(key => {
    const nodes = ring.getNodes(key, 3);
    console.log(`  ${key.padEnd(18)} → primary=${nodes[0]} replicas=[${nodes.slice(1).join(", ")}]`);
  });

  const dist = ring.distribution();
  console.log("  Virtual node distribution:", Object.entries(dist).map(([k, v]) => `${k}:${v}`).join(", "));

  ring.removeNode("node-2");
  console.log("  After removing node-2:");
  keys.forEach(key => console.log(`    ${key.padEnd(18)} → ${ring.getNode(key)}`));

  // ── AI Workload Router ──
  console.log("\n[5. AI Workload Router]");
  const router = new AIWorkloadRouter();
  router.registerServer(new MockModelServer("gpu-server-1"));
  router.registerServer(new MockModelServer("gpu-server-2"));
  router.registerServer(new MockModelServer("gpu-server-3", true)); // this one fails

  const routePromises = ["conv-1", "conv-2", "conv-3"].map(async (convId) => {
    try {
      const result = await router.route(convId, { model: "gpt-4", messages: [{ role: "user", content: "Hi" }] });
      console.log(`  ${convId} → routed to ${result.serverId}`);
    } catch (err) {
      console.log(`  ${convId} → ERROR: ${err instanceof Error ? err.message : err}`);
    }
  });
  // Execute sequentially for clean output
  for (const p of routePromises) await p;

  // ── Merkle Tree ──
  console.log("\n[6. Merkle Tree — Anti-entropy]");
  const dataA = [{ key: "k1", value: "v1" }, { key: "k2", value: "v2" }, { key: "k3", value: "v3" }];
  const dataB = [{ key: "k1", value: "v1" }, { key: "k2", value: "CHANGED" }, { key: "k3", value: "v3" }];

  const treeA = buildMerkleTree(dataA);
  const treeB = buildMerkleTree(dataB);

  console.log(`  Tree A root: ${treeA?.hash}`);
  console.log(`  Tree B root: ${treeB?.hash}`);
  console.log(`  Roots match: ${treeA?.hash === treeB?.hash}`);
  const diffs = diffMerkleTrees(treeA, treeB);
  console.log(`  Divergent keys: [${diffs.join(", ")}]`);

  // ── Conversation Sync Protocol ──
  console.log("\n[7. Conversation Sync Protocol]");
  const localConvs = new Map([["c1", "hash_a"], ["c2", "hash_b"], ["c3", "hash_c"]]);
  const remoteConvs = new Map([["c1", "hash_a"], ["c2", "hash_CHANGED"], ["c3", "hash_c"]]);

  const localSync = new ConversationSyncProtocol(localConvs);
  const remoteSync = new ConversationSyncProtocol(remoteConvs);

  console.log(`  Local root:  ${localSync.getMerkleRoot()}`);
  console.log(`  Remote root: ${remoteSync.getMerkleRoot()}`);

  const syncResult = localSync.syncWith(remoteSync);
  console.log(`  Matching: ${syncResult.matching}`);
  console.log(`  Keys to send: [${syncResult.toSend.join(", ")}]`);

  // Same data — should match
  const sameSync = new ConversationSyncProtocol(localConvs);
  const matchResult = localSync.syncWith(sameSync);
  console.log(`  Same data matching: ${matchResult.matching}`);

  // ── Gossip Protocol ──
  console.log("\n[8. Gossip Protocol]");
  const nodeA2 = new GossipNode("A");
  const nodeB2 = new GossipNode("B");
  const nodeC2 = new GossipNode("C");
  nodeA2.addPeer(nodeB2); nodeB2.addPeer(nodeA2);
  nodeB2.addPeer(nodeC2); nodeC2.addPeer(nodeB2);

  nodeA2.set("config:timeout", 5000);
  nodeA2.set("config:retries", 3);
  nodeB2.set("feature:dark-mode", true);

  for (let round = 0; round < 4; round++) {
    nodeA2.gossipOnce();
    nodeB2.gossipOnce();
    nodeC2.gossipOnce();
  }

  console.log(`  C.config:timeout = ${nodeC2.get("config:timeout")} (expect 5000)`);
  console.log(`  C.feature:dark-mode = ${nodeC2.get("feature:dark-mode")} (expect true)`);
  console.log(`  A.feature:dark-mode = ${nodeA2.get("feature:dark-mode")} (expect true)`);

  // ── Distributed Lock ──
  console.log("\n[9. Distributed Lock]");
  const lockStore = new InMemoryLockStore();
  const lock1 = new DistributedLock(lockStore, "job:inference");
  const lock2 = new DistributedLock(lockStore, "job:inference");

  const acq1 = lock1.acquire(10000);
  console.log(`  Lock1 acquired: ${acq1}`);

  const acq2 = lock2.acquire(10000, 1);
  console.log(`  Lock2 acquired (should fail): ${acq2}`);

  const ext = lock1.extend(5000);
  console.log(`  Lock1 extended: ${ext}`);

  lock1.release();
  console.log("  Lock1 released");

  const acq3 = lock2.acquire(10000, 1);
  console.log(`  Lock2 acquired after release: ${acq3}`);
  lock2.release();

  // withLock
  const lock3 = new DistributedLock(lockStore, "job:batch");
  const result = lock3.withLock(() => {
    return "computed result";
  });
  console.log(`  withLock result: "${result}"`);

  // ── Leader Election ──
  console.log("\n[10. Leader Election]");
  const leaderStore = new InMemoryLockStore();
  const electionLock1 = new DistributedLock(leaderStore, "leader:scheduler");
  const electionLock2 = new DistributedLock(leaderStore, "leader:scheduler");

  const election1 = new LeaderElection(electionLock1, "node-alpha");
  const election2 = new LeaderElection(electionLock2, "node-beta");

  election1.attemptLeadership();
  console.log(`  node-alpha isLeader: ${election1.isLeader()}`);

  election2.attemptLeadership();
  console.log(`  node-beta isLeader: ${election2.isLeader()}`);

  election1.stepDown();
  console.log(`  node-alpha stepped down, isLeader: ${election1.isLeader()}`);

  election2.attemptLeadership();
  console.log(`  node-beta after re-attempt: ${election2.isLeader()}`);

  console.log("\n✅ Bài 6 hoàn thành!\n");
}

main().catch(console.error);

export {}

# Bài 6: Distributed Systems Fundamentals với TypeScript

## Mục tiêu bài học

- Nắm vững CAP Theorem và ứng dụng trong AI systems
- Implement Vector Clocks và Merkle Trees từ đầu
- Thiết kế consistent hashing cho distributed AI workloads
- Xây dựng distributed lock và leader election với TypeScript

---

## 6.1 CAP Theorem và Thiết kế Quyết định

Trong distributed AI systems, ta phải chọn 2 trong 3:

```
         Consistency
             /\
            /  \
           /    \
          / CP   \
         /        \
        /----CA----\
       /     |     \
  Partition  |  Availability
  Tolerance  |
```

| System Type | Chọn | Hy sinh | Use Case |
|-------------|------|---------|----------|
| AI Gateway | CP | Availability | Accurate billing, auth |
| Chat History | AP | Consistency | Offline-first conversations |
| Model Registry | CA | Partition Tolerance | Internal datacenter only |
| Embedding Store | AP | Consistency | Cache layer, stale is OK |

```typescript
// CAP-aware cache với configurable consistency
type ConsistencyLevel = "strong" | "eventual" | "bounded-staleness";

interface CacheConfig {
  consistency: ConsistencyLevel;
  maxStalenessMs?: number;    // For bounded-staleness
  quorum?: number;            // For strong consistency (majority)
  replicationFactor: number;
}

class DistributedCache<T> {
  private nodes: Map<string, CacheNode<T>> = new Map();
  private config: CacheConfig;

  constructor(config: CacheConfig) {
    this.config = config;
  }

  async read(key: string): Promise<{ value: T | null; version: VectorClock }> {
    switch (this.config.consistency) {
      case "strong":
        return this.readQuorum(key);
      case "eventual":
        return this.readOne(key);
      case "bounded-staleness":
        return this.readWithStaleness(key, this.config.maxStalenessMs!);
    }
  }

  async write(key: string, value: T, clock: VectorClock): Promise<void> {
    switch (this.config.consistency) {
      case "strong":
        await this.writeQuorum(key, value, clock);
        break;
      case "eventual":
        await this.writeOne(key, value, clock);
        this.propagateAsync(key, value, clock);
        break;
      case "bounded-staleness":
        await this.writeQuorum(key, value, clock);
        break;
    }
  }

  private async readQuorum(key: string): Promise<{ value: T | null; version: VectorClock }> {
    const quorum = Math.floor(this.nodes.size / 2) + 1;
    const responses = await this.readFromNodes(key, quorum);
    // Return the response with the highest vector clock
    return responses.reduce((latest, current) =>
      VectorClock.compare(current.version, latest.version) > 0 ? current : latest
    );
  }

  private async readOne(key: string): Promise<{ value: T | null; version: VectorClock }> {
    const node = this.getPreferredNode(key);
    return node.get(key);
  }

  private async readWithStaleness(
    key: string,
    maxStalenessMs: number
  ): Promise<{ value: T | null; version: VectorClock }> {
    const node = this.getPreferredNode(key);
    const result = await node.get(key);
    const age = Date.now() - (result.version.wallTime ?? 0);
    if (age > maxStalenessMs) {
      // Stale: fetch fresh from quorum
      return this.readQuorum(key);
    }
    return result;
  }

  private async writeQuorum(key: string, value: T, clock: VectorClock): Promise<void> {
    const quorum = Math.floor(this.nodes.size / 2) + 1;
    const nodes = this.selectNodes(key, quorum);
    await Promise.all(nodes.map((n) => n.set(key, value, clock)));
  }

  private async writeOne(key: string, value: T, clock: VectorClock): Promise<void> {
    const node = this.getPreferredNode(key);
    await node.set(key, value, clock);
  }

  private propagateAsync(key: string, value: T, clock: VectorClock): void {
    // Fire-and-forget propagation to other nodes
    for (const [, node] of this.nodes) {
      node.set(key, value, clock).catch(console.error);
    }
  }

  private async readFromNodes(
    key: string,
    count: number
  ): Promise<Array<{ value: T | null; version: VectorClock }>> {
    const nodes = this.selectNodes(key, count);
    return Promise.all(nodes.map((n) => n.get(key)));
  }

  private getPreferredNode(key: string): CacheNode<T> {
    const nodes = Array.from(this.nodes.values());
    const index = this.hashKey(key) % nodes.length;
    return nodes[index];
  }

  private selectNodes(key: string, count: number): CacheNode<T>[] {
    const nodes = Array.from(this.nodes.values());
    const startIndex = this.hashKey(key) % nodes.length;
    const result: CacheNode<T>[] = [];
    for (let i = 0; i < count && i < nodes.length; i++) {
      result.push(nodes[(startIndex + i) % nodes.length]);
    }
    return result;
  }

  private hashKey(key: string): number {
    let hash = 5381;
    for (let i = 0; i < key.length; i++) {
      hash = ((hash << 5) + hash) + key.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash);
  }
}

interface CacheNode<T> {
  get(key: string): Promise<{ value: T | null; version: VectorClock }>;
  set(key: string, value: T, clock: VectorClock): Promise<void>;
}
```

---

## 6.2 Vector Clocks — Causal Ordering

```typescript
// Vector Clock implementation
class VectorClock {
  private clocks: Map<string, number>;
  wallTime: number;

  constructor(nodeId?: string, initialClocks?: Map<string, number>) {
    this.clocks = initialClocks ? new Map(initialClocks) : new Map();
    if (nodeId && !this.clocks.has(nodeId)) {
      this.clocks.set(nodeId, 0);
    }
    this.wallTime = Date.now();
  }

  tick(nodeId: string): VectorClock {
    const newClocks = new Map(this.clocks);
    newClocks.set(nodeId, (newClocks.get(nodeId) ?? 0) + 1);
    const newClock = new VectorClock(undefined, newClocks);
    newClock.wallTime = Date.now();
    return newClock;
  }

  merge(other: VectorClock): VectorClock {
    const merged = new Map(this.clocks);
    for (const [nodeId, time] of other.clocks) {
      merged.set(nodeId, Math.max(merged.get(nodeId) ?? 0, time));
    }
    const newClock = new VectorClock(undefined, merged);
    newClock.wallTime = Math.max(this.wallTime, other.wallTime);
    return newClock;
  }

  // Returns: 1 if a > b, -1 if a < b, 0 if concurrent
  static compare(a: VectorClock, b: VectorClock): number {
    let aGreater = false;
    let bGreater = false;

    const allNodes = new Set([...a.clocks.keys(), ...b.clocks.keys()]);

    for (const node of allNodes) {
      const aTime = a.clocks.get(node) ?? 0;
      const bTime = b.clocks.get(node) ?? 0;
      if (aTime > bTime) aGreater = true;
      if (bTime > aTime) bGreater = true;
    }

    if (aGreater && !bGreater) return 1;   // a happened after b
    if (bGreater && !aGreater) return -1;  // b happened after a
    if (!aGreater && !bGreater) return 0;  // equal
    return 0;                               // concurrent (both aGreater and bGreater)
  }

  happensBefore(other: VectorClock): boolean {
    return VectorClock.compare(this, other) === -1;
  }

  isConcurrentWith(other: VectorClock): boolean {
    const cmp = VectorClock.compare(this, other);
    // Concurrent if both have components greater than the other
    let thisGreater = false;
    let otherGreater = false;
    const allNodes = new Set([...this.clocks.keys(), ...other.clocks.keys()]);
    for (const node of allNodes) {
      const thisTime = this.clocks.get(node) ?? 0;
      const otherTime = other.clocks.get(node) ?? 0;
      if (thisTime > otherTime) thisGreater = true;
      if (otherTime > thisTime) otherGreater = true;
    }
    return thisGreater && otherGreater;
  }

  toJSON(): Record<string, number> {
    return Object.fromEntries(this.clocks);
  }

  static fromJSON(data: Record<string, number>): VectorClock {
    return new VectorClock(undefined, new Map(Object.entries(data)));
  }
}

// AI Event log with causal ordering
interface AIEvent {
  id: string;
  type: "message_sent" | "model_changed" | "config_updated" | "session_started";
  payload: Record<string, unknown>;
  vectorClock: VectorClock;
  nodeId: string;
  timestamp: Date;
}

class CausalEventLog {
  private events: AIEvent[] = [];
  private deliveredEvents = new Set<string>();
  private pendingEvents: AIEvent[] = [];

  constructor(private nodeId: string, private clock: VectorClock) {}

  append(type: AIEvent["type"], payload: Record<string, unknown>): AIEvent {
    this.clock = this.clock.tick(this.nodeId);
    const event: AIEvent = {
      id: crypto.randomUUID(),
      type,
      payload,
      vectorClock: this.clock,
      nodeId: this.nodeId,
      timestamp: new Date(),
    };
    this.events.push(event);
    return event;
  }

  receive(event: AIEvent): void {
    if (this.deliveredEvents.has(event.id)) return;
    
    this.pendingEvents.push(event);
    this.clock = this.clock.merge(event.vectorClock);
    this.tryDeliver();
  }

  private tryDeliver(): void {
    let delivered = true;
    while (delivered) {
      delivered = false;
      const ready = this.pendingEvents.filter((e) => this.canDeliver(e));
      
      for (const event of ready) {
        this.deliver(event);
        this.pendingEvents = this.pendingEvents.filter((e) => e.id !== event.id);
        delivered = true;
      }
    }
  }

  private canDeliver(event: AIEvent): boolean {
    // An event can be delivered if all events it causally depends on are delivered
    // For simplicity: check if all events with smaller vector clocks are delivered
    return !this.events.some(
      (e) =>
        !this.deliveredEvents.has(e.id) &&
        e.vectorClock.happensBefore(event.vectorClock)
    );
  }

  private deliver(event: AIEvent): void {
    this.events.push(event);
    this.deliveredEvents.add(event.id);
    this.events.sort((a, b) => VectorClock.compare(a.vectorClock, b.vectorClock));
  }

  getHistory(): AIEvent[] {
    return [...this.events];
  }
}
```

---

## 6.3 Consistent Hashing — Load Distribution

```typescript
// Consistent Hash Ring cho distributing AI workloads
class ConsistentHashRing {
  private ring: Map<number, string> = new Map();
  private sortedKeys: number[] = [];
  private virtualNodes: number;

  constructor(virtualNodes: number = 150) {
    this.virtualNodes = virtualNodes;
  }

  addNode(nodeId: string): void {
    for (let i = 0; i < this.virtualNodes; i++) {
      const virtualKey = `${nodeId}:${i}`;
      const hash = this.hash(virtualKey);
      this.ring.set(hash, nodeId);
    }
    this.sortedKeys = Array.from(this.ring.keys()).sort((a, b) => a - b);
  }

  removeNode(nodeId: string): void {
    for (let i = 0; i < this.virtualNodes; i++) {
      const virtualKey = `${nodeId}:${i}`;
      const hash = this.hash(virtualKey);
      this.ring.delete(hash);
    }
    this.sortedKeys = Array.from(this.ring.keys()).sort((a, b) => a - b);
  }

  getNode(key: string): string | null {
    if (this.ring.size === 0) return null;
    const hash = this.hash(key);
    
    // Find first node with hash >= key hash (clockwise)
    for (const ringHash of this.sortedKeys) {
      if (hash <= ringHash) {
        return this.ring.get(ringHash) ?? null;
      }
    }
    
    // Wrap around to first node
    return this.ring.get(this.sortedKeys[0]) ?? null;
  }

  getNodes(key: string, count: number): string[] {
    if (this.ring.size === 0) return [];
    const hash = this.hash(key);
    const nodes: string[] = [];
    const seen = new Set<string>();
    
    let startIdx = this.sortedKeys.findIndex((h) => h >= hash);
    if (startIdx === -1) startIdx = 0;
    
    let i = 0;
    while (nodes.length < count && i < this.sortedKeys.length) {
      const ringHash = this.sortedKeys[(startIdx + i) % this.sortedKeys.length];
      const nodeId = this.ring.get(ringHash)!;
      if (!seen.has(nodeId)) {
        nodes.push(nodeId);
        seen.add(nodeId);
      }
      i++;
    }
    
    return nodes;
  }

  private hash(key: string): number {
    // FNV-1a hash
    let hash = 2166136261;
    for (let i = 0; i < key.length; i++) {
      hash ^= key.charCodeAt(i);
      hash = (hash * 16777619) >>> 0;
    }
    return hash;
  }

  getDistribution(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const nodeId of this.ring.values()) {
      counts[nodeId] = (counts[nodeId] ?? 0) + 1;
    }
    return counts;
  }
}

// AI workload router using consistent hashing
class AIWorkloadRouter {
  private ring: ConsistentHashRing;
  private modelServers: Map<string, ModelServer> = new Map();

  constructor() {
    this.ring = new ConsistentHashRing(150);
  }

  registerServer(serverId: string, server: ModelServer): void {
    this.modelServers.set(serverId, server);
    this.ring.addNode(serverId);
    console.log(`Registered model server: ${serverId}`);
  }

  deregisterServer(serverId: string): void {
    this.modelServers.delete(serverId);
    this.ring.removeNode(serverId);
    console.log(`Deregistered model server: ${serverId}`);
  }

  // Route request to consistent server based on conversation/user ID
  async route(
    conversationId: string,
    request: ModelRequest
  ): Promise<ModelResponse> {
    // Same conversation always goes to same server (session affinity)
    const serverId = this.ring.getNode(conversationId);
    if (!serverId) throw new Error("No servers available");
    
    const server = this.modelServers.get(serverId);
    if (!server) throw new Error(`Server ${serverId} not found`);
    
    try {
      return await server.process(request);
    } catch (error) {
      // Failover: try next server in ring
      const fallbacks = this.ring.getNodes(conversationId, 3).slice(1);
      for (const fallbackId of fallbacks) {
        const fallback = this.modelServers.get(fallbackId);
        if (fallback) {
          try {
            return await fallback.process(request);
          } catch {
            continue;
          }
        }
      }
      throw new Error("All servers failed");
    }
  }
}

interface ModelServer {
  process(request: ModelRequest): Promise<ModelResponse>;
}

interface ModelRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
}

interface ModelResponse {
  content: string;
  usage: { promptTokens: number; completionTokens: number };
}
```

---

## 6.4 Merkle Trees — Data Integrity & Efficient Sync

```typescript
// Merkle Tree để verify data integrity và detect differences efficiently
class MerkleTree {
  private leaves: string[];
  private tree: string[][];

  constructor(data: string[]) {
    this.leaves = data.map((d) => this.hash(d));
    this.tree = this.buildTree(this.leaves);
  }

  private buildTree(leaves: string[]): string[][] {
    if (leaves.length === 0) return [[""]];
    
    const tree: string[][] = [leaves];
    let currentLevel = leaves;

    while (currentLevel.length > 1) {
      const nextLevel: string[] = [];
      for (let i = 0; i < currentLevel.length; i += 2) {
        const left = currentLevel[i];
        const right = currentLevel[i + 1] ?? left;
        nextLevel.push(this.hash(left + right));
      }
      tree.unshift(nextLevel);
      currentLevel = nextLevel;
    }

    return tree;
  }

  get root(): string {
    return this.tree[0]?.[0] ?? "";
  }

  // Get proof that a leaf is in the tree
  getProof(leafIndex: number): Array<{ hash: string; direction: "left" | "right" }> {
    const proof: Array<{ hash: string; direction: "left" | "right" }> = [];
    let currentIndex = leafIndex;

    for (let level = this.tree.length - 1; level > 0; level--) {
      const row = this.tree[level];
      const isLeft = currentIndex % 2 === 0;
      const siblingIndex = isLeft ? currentIndex + 1 : currentIndex - 1;
      
      if (siblingIndex < row.length) {
        proof.push({
          hash: row[siblingIndex],
          direction: isLeft ? "right" : "left",
        });
      }
      
      currentIndex = Math.floor(currentIndex / 2);
    }

    return proof;
  }

  // Verify a proof
  static verify(
    leafData: string,
    proof: Array<{ hash: string; direction: "left" | "right" }>,
    root: string
  ): boolean {
    const tree = new MerkleTree([]);
    let hash = tree.hash(leafData);

    for (const { hash: siblingHash, direction } of proof) {
      if (direction === "right") {
        hash = tree.hash(hash + siblingHash);
      } else {
        hash = tree.hash(siblingHash + hash);
      }
    }

    return hash === root;
  }

  // Find differing subtrees (for efficient sync)
  static diff(treeA: MerkleTree, treeB: MerkleTree): number[] {
    const diffIndices: number[] = [];
    
    function compare(levelA: string[], levelB: string[], index: number, leafCount: number): void {
      if (levelA[index] === levelB[index]) return;
      
      // Leaf node
      if (leafCount <= 1) {
        diffIndices.push(index);
        return;
      }
      
      // Recurse into children
      const leftChild = index * 2;
      const rightChild = index * 2 + 1;
      const halfLeaves = Math.ceil(leafCount / 2);
      
      if (leftChild < levelA.length) {
        compare(levelA, levelB, leftChild, halfLeaves);
      }
      if (rightChild < levelA.length) {
        compare(levelA, levelB, rightChild, leafCount - halfLeaves);
      }
    }

    if (treeA.root !== treeB.root) {
      // Trees differ, find which leaves
      const maxLeaves = Math.max(treeA.leaves.length, treeB.leaves.length);
      const paddedA = [...treeA.leaves, ...Array(maxLeaves - treeA.leaves.length).fill("")];
      const paddedB = [...treeB.leaves, ...Array(maxLeaves - treeB.leaves.length).fill("")];
      
      for (let i = 0; i < maxLeaves; i++) {
        if (paddedA[i] !== paddedB[i]) {
          diffIndices.push(i);
        }
      }
    }

    return diffIndices;
  }

  private hash(data: string): string {
    // Simple hash (use SHA-256 in production)
    let hash = 5381;
    for (let i = 0; i < data.length; i++) {
      hash = ((hash << 5) + hash) + data.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash).toString(16).padStart(8, "0");
  }
}

// Use Merkle Tree for efficient AI conversation sync
class ConversationSyncProtocol {
  private tree: MerkleTree;
  private conversations: Map<string, string>; // id -> content hash

  constructor(conversations: Map<string, string>) {
    this.conversations = conversations;
    const sortedIds = Array.from(conversations.keys()).sort();
    this.tree = new MerkleTree(
      sortedIds.map((id) => `${id}:${conversations.get(id)}`)
    );
  }

  getMerkleRoot(): string {
    return this.tree.root;
  }

  // Fast sync: only transfer conversations that differ
  async syncWith(remote: ConversationSyncProtocol): Promise<{
    toSend: string[];
    toReceive: string[];
  }> {
    if (this.tree.root === remote.tree.root) {
      return { toSend: [], toReceive: [] };
    }

    // Find differing leaves
    const diffIndices = MerkleTree.diff(this.tree, remote.tree);
    const sortedIds = Array.from(this.conversations.keys()).sort();
    
    const toSend: string[] = [];
    const toReceive: string[] = [];

    for (const idx of diffIndices) {
      const localId = sortedIds[idx];
      if (localId && this.conversations.has(localId)) {
        toSend.push(localId);
      }
    }

    return { toSend, toReceive };
  }
}
```

---

## 6.5 Distributed Lock & Leader Election

```typescript
// Distributed lock using Redis-like TTL (conceptual, using any KV store)
interface LockStore {
  setNX(key: string, value: string, ttlMs: number): Promise<boolean>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<void>;
  extend(key: string, ttlMs: number, expectedValue: string): Promise<boolean>;
}

class DistributedLock {
  private readonly ownerId: string;

  constructor(
    private store: LockStore,
    private lockKey: string
  ) {
    this.ownerId = `${Date.now()}:${Math.random().toString(36)}`;
  }

  async acquire(ttlMs: number = 30000, retries: number = 3): Promise<boolean> {
    for (let i = 0; i < retries; i++) {
      const acquired = await this.store.setNX(
        this.lockKey,
        this.ownerId,
        ttlMs
      );
      if (acquired) return true;
      
      // Exponential backoff
      await sleep(Math.min(100 * Math.pow(2, i), 1000));
    }
    return false;
  }

  async release(): Promise<void> {
    const current = await this.store.get(this.lockKey);
    if (current === this.ownerId) {
      await this.store.del(this.lockKey);
    }
    // If not owner, lock was expired or stolen — don't delete
  }

  async extend(additionalMs: number): Promise<boolean> {
    return this.store.extend(this.lockKey, additionalMs, this.ownerId);
  }

  // Atomic operation with lock
  async withLock<T>(
    fn: () => Promise<T>,
    options: { ttlMs?: number; retries?: number } = {}
  ): Promise<T> {
    const acquired = await this.acquire(options.ttlMs, options.retries);
    if (!acquired) throw new Error(`Could not acquire lock: ${this.lockKey}`);
    
    try {
      return await fn();
    } finally {
      await this.release();
    }
  }
}

// Leader election for AI scheduler
class LeaderElection {
  private isLeader = false;
  private leaderCheckInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private lock: DistributedLock,
    private nodeId: string,
    private onBecomeLeader: () => void,
    private onLoseLeadership: () => void
  ) {}

  async start(checkIntervalMs: number = 5000): Promise<void> {
    await this.attemptLeadership();
    
    this.leaderCheckInterval = setInterval(async () => {
      await this.attemptLeadership();
    }, checkIntervalMs);
  }

  stop(): void {
    if (this.leaderCheckInterval) {
      clearInterval(this.leaderCheckInterval);
      this.leaderCheckInterval = null;
    }
    if (this.isLeader) {
      this.lock.release();
      this.isLeader = false;
    }
  }

  private async attemptLeadership(): Promise<void> {
    if (this.isLeader) {
      // Extend leadership lease
      const extended = await this.lock.extend(15000);
      if (!extended) {
        this.isLeader = false;
        this.onLoseLeadership();
      }
    } else {
      // Try to become leader
      const acquired = await this.lock.acquire(15000, 1);
      if (acquired) {
        this.isLeader = true;
        this.onBecomeLeader();
      }
    }
  }

  getIsLeader(): boolean {
    return this.isLeader;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

---

## Tóm tắt Bài 6

| Concept | TypeScript Implementation | AI Use Case |
|---------|--------------------------|-------------|
| CAP Theorem | Configurable consistency levels | Cache vs accuracy trade-off |
| Vector Clocks | Causal ordering of events | Distributed conversation state |
| Consistent Hashing | Virtual nodes ring | Route requests to AI servers |
| Merkle Trees | Efficient diff detection | Sync only changed conversations |
| Distributed Lock | TTL-based CAS operations | Prevent duplicate AI jobs |
| Leader Election | Lock-based heartbeat | Single AI scheduler per cluster |

## Bài tập thực hành

1. Implement **Anti-Entropy Protocol**: định kỳ compare Merkle roots với peers và sync differences.
2. Xây dựng **Gossip Protocol** đơn giản: mỗi node định kỳ gossip với random peers để propagate updates.
3. Implement **Raft Consensus** simplified version cho AI cluster state management.

---

*Tiếp theo: [Bài 7 — Event Sourcing & CQRS](07-event-sourcing-cqrs.md)*

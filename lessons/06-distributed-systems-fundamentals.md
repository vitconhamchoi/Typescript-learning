# Bài 6: Distributed Systems Fundamentals với TypeScript

## Mục tiêu bài học

- Nắm vững CAP Theorem và ứng dụng trong AI systems
- Implement Vector Clocks và Merkle Trees từ đầu
- Thiết kế consistent hashing cho distributed AI workloads
- Xây dựng distributed lock và leader election với TypeScript

---

## 6.1 CAP Theorem và Thiết kế Quyết định

Trong distributed AI systems, ta phải chọn 2 trong 3: **Consistency**, **Availability**, **Partition Tolerance**.

| System Type | Chọn | Hy sinh | Use Case |
|-------------|------|---------|----------|
| AI Gateway | CP | Availability | Accurate billing, auth |
| Chat History | AP | Consistency | Offline-first conversations |
| Embedding Store | AP | Consistency | Cache layer, stale is OK |

```typescript
type ConsistencyLevel = "strong" | "eventual" | "bounded-staleness";

interface CacheConfig {
  consistency: ConsistencyLevel;
  maxStalenessMs?: number;
  quorum?: number;
  replicationFactor: number;
}
```

```typescript
// CAP-aware read: pick strategy based on consistency level
async function read(key: string, config: CacheConfig) {
  switch (config.consistency) {
    case "strong": return readQuorum(key);
    case "eventual": return readOne(key);
    case "bounded-staleness": return readWithStaleness(key, config.maxStalenessMs!);
  }
}
```

---

## 6.2 Vector Clocks — Causal Ordering

Vector Clock tracks causality giữa các nodes. Mỗi node giữ counter riêng.

```typescript
type VectorClock = Map<string, number>;

function vcIncrement(vc: VectorClock, nodeId: string): VectorClock {
  const next = new Map(vc);
  next.set(nodeId, (next.get(nodeId) ?? 0) + 1);
  return next;
}

function vcMerge(a: VectorClock, b: VectorClock): VectorClock {
  const merged = new Map(a);
  for (const [node, tick] of b) merged.set(node, Math.max(merged.get(node) ?? 0, tick));
  return merged;
}
```

So sánh hai clocks để xác định causal ordering:

```typescript
type CausalOrder = "before" | "after" | "concurrent" | "equal";

function vcCompare(a: VectorClock, b: VectorClock): CausalOrder {
  let aLess = false, bLess = false;
  for (const node of new Set([...a.keys(), ...b.keys()])) {
    if ((a.get(node) ?? 0) < (b.get(node) ?? 0)) aLess = true;
    if ((b.get(node) ?? 0) < (a.get(node) ?? 0)) bLess = true;
  }
  if (!aLess && !bLess) return "equal";
  if (aLess && !bLess) return "before";
  if (!aLess && bLess) return "after";
  return "concurrent";
}
```

---

## 6.3 Consistent Hashing — Load Distribution

Consistent hashing dùng virtual nodes trên hash ring để phân bổ keys đều giữa các servers.

```typescript
class ConsistentHashRing {
  private ring: { hash: number; nodeId: string }[] = [];

  addNode(nodeId: string): void {
    for (let i = 0; i < this.replicas; i++) {
      this.ring.push({ hash: fnv1a(`${nodeId}:${i}`), nodeId });
    }
    this.ring.sort((a, b) => a.hash - b.hash);
  }

  getNode(key: string): string | null {
    const h = fnv1a(key);
    const vnode = this.ring.find((n) => n.hash >= h) ?? this.ring[0];
    return vnode?.nodeId ?? null;
  }
}
```

---

## 6.4 Merkle Trees — Data Integrity & Efficient Sync

Merkle Tree cho phép so sánh datasets lớn chỉ bằng cách compare root hash, rồi drill down tìm khác biệt.

```typescript
interface MerkleNode {
  hash: string;
  left: MerkleNode | null;
  right: MerkleNode | null;
  isLeaf: boolean;
  key?: string;
}

function diffMerkleTrees(a: MerkleNode | null, b: MerkleNode | null): string[] {
  if (!a || !b) return ["root"];
  if (a.hash === b.hash) return [];
  if (a.isLeaf && b.isLeaf) return [a.key ?? "unknown"];
  return [...diffMerkleTrees(a.left, b.left), ...diffMerkleTrees(a.right, b.right)];
}
```

---

## 6.5 Gossip Protocol — Epidemic Information Dissemination

Mỗi node định kỳ gửi digest (key→version) cho random peer, peer trả lại entries mới hơn.

```typescript
class GossipNode {
  private state: Record<string, { value: unknown; version: number }> = {};

  gossipOnce(): void {
    const peer = this.randomPeer();
    const digest = Object.fromEntries(
      Object.entries(this.state).map(([k, v]) => [k, v.version])
    );
    const updates = peer.handleDigest(digest);
    for (const msg of updates) this.mergeIfNewer(msg);
  }
}
```

---

## 6.6 Distributed Lock & Leader Election

Distributed lock dùng TTL + CAS (Compare-And-Swap) để ensure mutual exclusion.

```typescript
interface LockStore {
  setNX(key: string, value: string, ttlMs: number): Promise<boolean>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<void>;
  extend(key: string, ttlMs: number, expected: string): Promise<boolean>;
}
```

Leader election dựa trên lock: node nào acquire được lock trước là leader.

```typescript
class LeaderElection {
  private isLeader = false;

  async attemptLeadership(): Promise<void> {
    if (this.isLeader) {
      if (!(await this.lock.extend(15000))) this.onLoseLeadership();
    } else if (await this.lock.acquire(15000, 1)) {
      this.isLeader = true;
      this.onBecomeLeader();
    }
  }
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
| Gossip Protocol | Digest-based reconciliation | Propagate config across cluster |
| Distributed Lock | TTL-based CAS operations | Prevent duplicate AI jobs |
| Leader Election | Lock-based heartbeat | Single AI scheduler per cluster |

## Bài tập thực hành

1. Implement **Anti-Entropy Protocol**: định kỳ compare Merkle roots với peers và sync differences.
2. Xây dựng **Gossip Protocol** đơn giản: mỗi node định kỳ gossip với random peers để propagate updates.
3. Implement **Raft Consensus** simplified version cho AI cluster state management.

---

*Tiếp theo: [Bài 7 — Event Sourcing & CQRS](07-event-sourcing-cqrs.md)*

/**
 * Bài 6: Distributed Systems Fundamentals
 * ==========================================
 * Chạy: npm run lesson06
 *
 * Nội dung:
 *  - Vector Clocks (causality tracking)
 *  - Consistent Hashing (node routing)
 *  - Merkle Tree (anti-entropy / diff detection)
 *  - Gossip protocol simulation
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
// 2. CONSISTENT HASHING
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

  /** Get n replicas for fault tolerance */
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
// 3. MERKLE TREE
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
      const right = leaves[i + 1] ?? left; // odd node: pair with itself
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
// 4. GOSSIP PROTOCOL SIMULATION
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

  /** Send digest to random peer and reconcile */
  gossipOnce(): void {
    if (this.peers.length === 0) return;
    const peer = this.peers[Math.floor(Math.random() * this.peers.length)]!;
    const digest: Record<string, number> = {};
    for (const [k, msg] of Object.entries(this.state)) digest[k] = msg.version;

    // Peer responds with newer entries
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
// DEMO / RUN
// ─────────────────────────────────────────────────────────────────────────────

function main() {
  console.log("\n══════════════════════════════════════");
  console.log(" Bài 6: Distributed Systems Fundamentals");
  console.log("══════════════════════════════════════\n");

  // ── Vector Clocks ──
  console.log("[Vector Clocks]");
  let vcA: VectorClock = new Map();
  let vcB: VectorClock = new Map();

  vcA = vcIncrement(vcA, "A");
  vcA = vcIncrement(vcA, "A");
  vcB = vcIncrement(vcB, "B");

  console.log(`  A: ${vcToString(vcA)}`);
  console.log(`  B: ${vcToString(vcB)}`);
  console.log(`  A vs B: ${vcCompare(vcA, vcB)}`); // concurrent

  // Merge B into A (A receives B's message)
  const merged = vcMerge(vcA, vcB);
  const vcA2   = vcIncrement(merged, "A");
  console.log(`  After A merges B and increments: ${vcToString(vcA2)}`);
  console.log(`  vcB vs vcA2: ${vcCompare(vcB, vcA2)}`); // before

  // ── Consistent Hashing ──
  console.log("\n[Consistent Hashing]");
  const ring = new ConsistentHashRing(100);
  ["node-1", "node-2", "node-3", "node-4"].forEach(n => ring.addNode(n));

  const keys = ["user:alice", "user:bob", "session:xyz", "cache:home", "cache:profile"];
  keys.forEach(key => {
    const nodes = ring.getNodes(key, 3);
    console.log(`  ${key.padEnd(18)} → primary=${nodes[0]} replicas=[${nodes.slice(1).join(", ")}]`);
  });

  const dist = ring.distribution();
  console.log("  Virtual node distribution:", Object.entries(dist).map(([k, v]) => `${k}:${v}`).join(", "));

  // Node failure: remove node-2
  ring.removeNode("node-2");
  console.log("  After removing node-2:");
  keys.forEach(key => console.log(`    ${key.padEnd(18)} → ${ring.getNode(key)}`));

  // ── Merkle Tree ──
  console.log("\n[Merkle Tree — Anti-entropy]");
  const dataA = [{ key: "k1", value: "v1" }, { key: "k2", value: "v2" }, { key: "k3", value: "v3" }];
  const dataB = [{ key: "k1", value: "v1" }, { key: "k2", value: "CHANGED" }, { key: "k3", value: "v3" }];

  const treeA = buildMerkleTree(dataA);
  const treeB = buildMerkleTree(dataB);

  console.log(`  Tree A root: ${treeA?.hash}`);
  console.log(`  Tree B root: ${treeB?.hash}`);
  console.log(`  Roots match: ${treeA?.hash === treeB?.hash}`);
  const diffs = diffMerkleTrees(treeA, treeB);
  console.log(`  Divergent keys: [${diffs.join(", ")}]`);

  // ── Gossip Protocol ──
  console.log("\n[Gossip Protocol]");
  const nodeA = new GossipNode("A");
  const nodeB = new GossipNode("B");
  const nodeC = new GossipNode("C");
  nodeA.addPeer(nodeB); nodeB.addPeer(nodeA);
  nodeB.addPeer(nodeC); nodeC.addPeer(nodeB);

  nodeA.set("config:timeout", 5000);
  nodeA.set("config:retries", 3);
  nodeB.set("feature:dark-mode", true);

  // Gossip rounds
  for (let round = 0; round < 4; round++) {
    nodeA.gossipOnce();
    nodeB.gossipOnce();
    nodeC.gossipOnce();
  }

  console.log(`  C.config:timeout = ${nodeC.get("config:timeout")} (expect 5000)`);
  console.log(`  C.feature:dark-mode = ${nodeC.get("feature:dark-mode")} (expect true)`);
  console.log(`  A.feature:dark-mode = ${nodeA.get("feature:dark-mode")} (expect true)`);

  console.log("\n✅ Bài 6 hoàn thành!\n");
}

main();

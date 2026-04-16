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
class GCounter {
  private state: Map<NodeId, number>;
  constructor(private nodeId: NodeId) {
    this.state = new Map([[nodeId, 0]]);
  }

  increment(by = 1): void {
    this.state.set(this.nodeId, (this.state.get(this.nodeId) ?? 0) + by);
  }

  value(): number {
    let total = 0;
    for (const count of this.state.values()) total += count;
    return total;
  }

  // Merge: take max per node — guarantees convergence
  merge(other: GCounter): void {
    for (const [nodeId, count] of other.state)
      this.state.set(nodeId, Math.max(this.state.get(nodeId) ?? 0, count));
  }
}
```

Use case: tracking AI token usage across devices (mỗi device increment riêng, merge khi sync).

---

## 4.3 LWW-Register (Last-Write-Wins Register)

```typescript
// Hybrid Logical Clock — ordering chính xác hơn wall clock
type HLC = { wallTime: number; logical: number; nodeId: string };

function hlcCompare(a: HLC, b: HLC): number {
  if (a.wallTime !== b.wallTime) return a.wallTime - b.wallTime;
  if (a.logical !== b.logical) return a.logical - b.logical;
  return a.nodeId.localeCompare(b.nodeId);
}

// LWW Register — last write (by HLC timestamp) wins on merge
class LWWRegister<T> {
  private entry: { value: T; timestamp: HLC };

  set(value: T): void {
    this.entry = { value, timestamp: hlcNow(this.nodeId) };
  }

  merge(other: LWWRegister<T>): void {
    if (hlcCompare(other.entry.timestamp, this.entry.timestamp) > 0)
      this.entry = { ...other.entry };
  }
}
```

LWW-Map mở rộng pattern này thành document CRDT — mỗi field là một LWW-Register riêng biệt.

---

## 4.4 OR-Set (Observed-Remove Set)

OR-Set cho phép cả add và remove mà không conflict:

```typescript
// OR-Set: mỗi add tạo unique tag, remove chỉ xóa tags đã observe
class ORSet<T> {
  private added = new Map<string, { value: T; uid: string }>();
  private removed = new Set<string>();

  add(value: T): void {
    const uid = `${this.nodeId}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    this.added.set(uid, { value, uid });
  }

  remove(value: T): void {
    for (const [uid, entry] of this.added)
      if (JSON.stringify(entry.value) === JSON.stringify(value))
        this.removed.add(uid);
  }

  // Merge: union of adds + union of removes
  merge(other: ORSet<T>): void {
    for (const [uid, entry] of other.added) this.added.set(uid, entry);
    for (const uid of other.removed) this.removed.add(uid);
  }

  values(): T[] {
    return [...this.added.entries()]
      .filter(([uid]) => !this.removed.has(uid))
      .map(([, e]) => e.value);
  }
}
```

---

## 4.5 Automerge — Production CRDT Library

Automerge handles complex data structures automatically:

```typescript
// Define document type
interface AIConfig {
  systemPrompt: string;
  temperature: number;
  tools: string[];
}

// Automerge change + merge pattern
let doc = Automerge.from<AIConfig>({
  systemPrompt: "You are helpful.",
  temperature: 0.7,
  tools: [],
});

doc = Automerge.change(doc, (d) => {
  d.tools.push("web-search");
  d.temperature = 0.9;
});

// Merge two peers — conflicts resolved automatically
const merged = Automerge.merge(docA, docB);
```

---

## 4.6 Yjs — Real-time Collaborative Editing cho AI

Yjs là lựa chọn tốt nhất cho collaborative text editing (shared prompts, documents):

```typescript
// Yjs shared types — CRDT-backed collaborative data
const ydoc = new Y.Doc();
const sharedPrompt = ydoc.getText("systemPrompt");
const sharedConfig = ydoc.getMap("config");

// Text operations — mỗi character có unique ID
sharedPrompt.insert(0, "You are a helpful assistant.");

// Observe real-time changes
sharedPrompt.observe((event) => {
  console.log("Text changed:", event.delta);
});

// Undo/Redo support
const undoManager = new Y.UndoManager([sharedPrompt, sharedConfig]);
undoManager.undo();
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

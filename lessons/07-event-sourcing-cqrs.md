# Bài 7: Event Sourcing & CQRS với TypeScript

## Mục tiêu bài học

- Implement Event Store từ đầu với TypeScript
- Xây dựng CQRS (Command Query Responsibility Segregation) cho AI systems
- Thiết kế Projections và Read Models cho real-time dashboards
- Implement Saga pattern cho multi-step AI workflows
- Outbox pattern để đảm bảo at-least-once delivery

---

## 7.1 Event Store Fundamentals

Mỗi domain event là một **fact** đã xảy ra — không thể thay đổi, chỉ append. Dùng discriminated union để TypeScript narrowing tự động payload theo `type`:

```typescript
interface BaseEvent {
  readonly eventId: string;
  readonly aggregateId: string;
  readonly aggregateType: string;
  readonly occurredAt: string;
  readonly version: number;
}

interface NoteCreated extends BaseEvent {
  type: "NoteCreated";
  payload: { title: string; body: string; authorId: string };
}
interface NoteDeleted extends BaseEvent {
  type: "NoteDeleted";
  payload: Record<string, never>;
}

type NoteEvent = NoteCreated | NoteDeleted; // union mở rộng dễ dàng
```

Khi `switch (event.type)`, TypeScript sẽ narrow `event.payload` tự động — zero runtime cost, full type safety.

---

## 7.2 Event Store Implementation

EventStore là **append-only log** với **optimistic concurrency control** — nếu hai writer cùng ghi vào một aggregate, version conflict sẽ throw error:

```typescript
class EventStore extends EventEmitter<{ appended: [DomainEvent] }> {
  private log: DomainEvent[] = [];
  private sequences = new Map<string, number>();

  append(event: Omit<DomainEvent, "eventId" | "occurredAt">): DomainEvent {
    const expected = this.sequences.get(event.aggregateId) ?? 0;
    if (event.version !== expected + 1) {
      throw new Error(`Concurrency conflict: expected v${expected + 1}`);
    }
    const stored = { ...event, eventId: crypto.randomUUID(),
      occurredAt: new Date().toISOString() } as DomainEvent;
    this.log.push(stored);
    this.sequences.set(event.aggregateId, event.version);
    this.emit("appended", stored);
    return stored;
  }
}
```

`EventEmitter` cho phép projection subscribe real-time mà không coupling trực tiếp.

---

## 7.3 Aggregate Pattern

Aggregate **replay toàn bộ event stream** để reconstruct state hiện tại — đây là trái tim của Event Sourcing:

```typescript
class NoteAggregate {
  private state: NoteState = { id: "", title: "", tags: new Set(), version: 0 };

  private rehydrate(): this {
    const events = this.store.getStream(this.id);
    this.state = { id: this.id, title: "", tags: new Set(), version: 0 };
    for (const event of events) this.apply(event as NoteEvent);
    return this;
  }

  private apply(event: NoteEvent): void {
    this.state.version = event.version;
    switch (event.type) {
      case "NoteCreated": this.state.title = event.payload.title; break;
      case "NoteTagged":  this.state.tags.add(event.payload.tag); break;
      case "NoteDeleted": this.state.deleted = true; break;
    }
  }
}
```

Command methods (rename, addTag) tạo event mới → append vào store → update local state.

---

## 7.4 CQRS — Projections & Read Models

**Write side** (Aggregate) và **Read side** (Projection) tách biệt hoàn toàn. Projection build read model bằng cách fold events qua `switch/case`:

```typescript
class NoteProjection {
  private models = new Map<string, NoteReadModel>();

  project(events: DomainEvent[]): void {
    for (const event of events) {
      if (event.aggregateType !== "Note") continue;
      const ne = event as NoteEvent;
      switch (ne.type) {
        case "NoteCreated":
          this.models.set(ne.aggregateId, {
            id: ne.aggregateId, title: ne.payload.title,
            tags: [], deleted: false, eventCount: 1,
          });
          break;
        case "NoteTitled": {
          const m = this.models.get(ne.aggregateId);
          if (m) { m.title = ne.payload.title; m.eventCount++; }
          break;
        }
      }
    }
  }
}
```

Read model có thể có **schema khác hoàn toàn** so với aggregate — tối ưu cho từng query pattern.

---

## 7.5 Saga Pattern cho AI Workflows

Saga quản lý multi-step workflow bằng **state machine** + **compensation** khi fail. Mỗi step là một transition, nếu bất kỳ step nào fail → rollback các step đã hoàn thành:

```typescript
type SagaState =
  | { step: "idle" }
  | { step: "uploading"; documentId: string }
  | { step: "chunking"; documentId: string; totalChunks: number }
  | { step: "embedding"; documentId: string }
  | { step: "complete"; documentId: string; duration: number }
  | { step: "failed"; error: string; compensating: boolean };

async execute(docName: string): Promise<string> {
  try {
    this.state = { step: "uploading", documentId: "" };
    const docId = await this.services.storage.upload(docName);
    this.state = { step: "chunking", documentId: docId, totalChunks: 0 };
    const chunks = await this.services.chunker.chunk(docId);
    // ... tiếp tục embedding → indexing → complete
  } catch (error) {
    await this.compensate(docId); // rollback
  }
}
```

`getProgress()` dùng exhaustive switch trên discriminated union → TypeScript đảm bảo handle hết mọi state.

---

## 7.6 Outbox Pattern — Reliable Event Publishing

Outbox pattern đảm bảo **at-least-once delivery**: ghi event vào outbox table cùng transaction với domain data, sau đó background worker poll và dispatch:

```typescript
interface OutboxEntry {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: string;       // JSON serialized
  status: "pending" | "dispatched";
  createdAt: string;
}

class OutboxPublisher {
  write(event: DomainEvent): void {
    this.entries.push({
      id: `out_${Date.now()}`, aggregateId: event.aggregateId,
      eventType: event.type, payload: JSON.stringify(event),
      status: "pending", createdAt: new Date().toISOString(),
    });
  }

  async publish(dispatcher: (e: OutboxEntry) => Promise<void>): Promise<void> {
    for (const entry of this.entries.filter(e => e.status === "pending")) {
      await dispatcher(entry);
      entry.status = "dispatched";
    }
  }
}
```

Kết hợp với EventStore listener: `store.on("appended", e => outbox.write(e))` — mọi event đều được ghi vào outbox tự động.

---

## Tóm tắt Bài 7

| Pattern | TypeScript Pattern | AI Use Case |
|---------|-------------------|-------------|
| Event Store | Class + Map + EventEmitter | Immutable conversation history |
| Aggregate | Replay events → reconstruct state | Conversation domain logic |
| CQRS | Separate read/write models | Fast dashboards + reliable writes |
| Projection | Fold events qua switch/case | Real-time user stats |
| Saga | State machine + compensation | Document processing pipeline |
| Outbox | Queue + polling processor | Reliable webhook delivery |

## Bài tập thực hành

1. Implement **Snapshot Strategy**: khi aggregate có >100 events, tạo snapshot để tránh replay toàn bộ history.
2. Xây dựng **Cost Tracking Projection**: tính toán token cost per user per day từ event stream.
3. Implement **Process Manager** (Advanced Saga): orchestrate multi-service AI workflow với compensation transactions.

---

*Tiếp theo: [Bài 8 — AI Gateway Design](08-ai-gateway-design.md)*

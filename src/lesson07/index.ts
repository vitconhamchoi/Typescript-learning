/**
 * Bài 7: Event Sourcing & CQRS
 * ============================
 * Chạy: npm run lesson07
 *
 * Nội dung:
 *  - Typed EventStore với append-only log
 *  - Aggregate reconstruction (replay)
 *  - Projection / read-model builder
 *  - Saga / Process Manager pattern
 *  - Outbox pattern (guaranteed delivery)
 */

import { EventEmitter } from "eventemitter3";

// ─────────────────────────────────────────────────────────────────────────────
// 1. DOMAIN EVENTS (discriminated union)
// ─────────────────────────────────────────────────────────────────────────────

interface BaseEvent {
  readonly eventId: string;
  readonly aggregateId: string;
  readonly aggregateType: string;
  readonly occurredAt: string; // ISO 8601
  readonly version: number;    // aggregate version at time of event
}

// Note domain events
interface NoteCreated  extends BaseEvent { type: "NoteCreated";  payload: { title: string; body: string; authorId: string } }
interface NoteTitled   extends BaseEvent { type: "NoteTitled";   payload: { title: string } }
interface NoteTagged   extends BaseEvent { type: "NoteTagged";   payload: { tag: string } }
interface NoteUntagged extends BaseEvent { type: "NoteUntagged"; payload: { tag: string } }
interface NoteDeleted  extends BaseEvent { type: "NoteDeleted";  payload: Record<string, never> }

type NoteEvent = NoteCreated | NoteTitled | NoteTagged | NoteUntagged | NoteDeleted;

// User domain events
interface UserRegistered extends BaseEvent { type: "UserRegistered"; payload: { email: string; name: string } }
interface UserRenamed    extends BaseEvent { type: "UserRenamed";    payload: { name: string } }

type UserEvent = UserRegistered | UserRenamed;

type DomainEvent = NoteEvent | UserEvent;

// ─────────────────────────────────────────────────────────────────────────────
// 2. TYPED EVENT STORE
// ─────────────────────────────────────────────────────────────────────────────

interface EventStoreEvents {
  appended: [event: DomainEvent];
}

class EventStore extends EventEmitter<EventStoreEvents> {
  private log: DomainEvent[] = [];
  private sequences = new Map<string, number>(); // aggregateId → latest version

  append(event: Omit<DomainEvent, "eventId" | "occurredAt">): DomainEvent {
    const stored = {
      ...event,
      eventId:    `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      occurredAt: new Date().toISOString(),
    } as DomainEvent;

    const expected = this.sequences.get(event.aggregateId) ?? 0;
    if (event.version !== expected + 1) {
      throw new Error(
        `Optimistic concurrency conflict for ${event.aggregateId}: expected version ${expected + 1}, got ${event.version}`,
      );
    }
    this.log.push(stored);
    this.sequences.set(event.aggregateId, event.version);
    this.emit("appended", stored);
    return stored;
  }

  getStream(aggregateId: string): DomainEvent[] {
    return this.log.filter(e => e.aggregateId === aggregateId);
  }

  getAll(fromVersion = 0): DomainEvent[] {
    return this.log.slice(fromVersion);
  }

  currentVersion(aggregateId: string): number {
    return this.sequences.get(aggregateId) ?? 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. AGGREGATE — Note
// ─────────────────────────────────────────────────────────────────────────────

interface NoteState {
  id: string;
  title: string;
  body: string;
  authorId: string;
  tags: Set<string>;
  deleted: boolean;
  version: number;
}

class NoteAggregate {
  private state: NoteState = {
    id: "", title: "", body: "", authorId: "",
    tags: new Set(), deleted: false, version: 0,
  };

  private constructor(private readonly store: EventStore, private readonly id: string) {}

  static create(store: EventStore, id: string, authorId: string, title: string, body: string): NoteAggregate {
    const agg = new NoteAggregate(store, id);
    store.append({ type: "NoteCreated", aggregateId: id, aggregateType: "Note", version: 1, payload: { title, body, authorId } });
    return agg.rehydrate();
  }

  static load(store: EventStore, id: string): NoteAggregate {
    return new NoteAggregate(store, id).rehydrate();
  }

  private rehydrate(): this {
    const events = this.store.getStream(this.id);
    this.state = { id: this.id, title: "", body: "", authorId: "", tags: new Set(), deleted: false, version: 0 };
    for (const event of events) this.apply(event as NoteEvent);
    return this;
  }

  private apply(event: NoteEvent): void {
    this.state.version = event.version;
    switch (event.type) {
      case "NoteCreated":  this.state.title = event.payload.title; this.state.body = event.payload.body; this.state.authorId = event.payload.authorId; break;
      case "NoteTitled":   this.state.title = event.payload.title; break;
      case "NoteTagged":   this.state.tags.add(event.payload.tag); break;
      case "NoteUntagged": this.state.tags.delete(event.payload.tag); break;
      case "NoteDeleted":  this.state.deleted = true; break;
    }
  }

  rename(title: string): void {
    this.store.append({ type: "NoteTitled", aggregateId: this.id, aggregateType: "Note", version: this.state.version + 1, payload: { title } });
    this.state.title = title; this.state.version++;
  }

  addTag(tag: string): void {
    this.store.append({ type: "NoteTagged", aggregateId: this.id, aggregateType: "Note", version: this.state.version + 1, payload: { tag } });
    this.state.tags.add(tag); this.state.version++;
  }

  delete(): void {
    this.store.append({ type: "NoteDeleted", aggregateId: this.id, aggregateType: "Note", version: this.state.version + 1, payload: {} });
    this.state.deleted = true; this.state.version++;
  }

  get snapshot(): Readonly<NoteState> { return { ...this.state, tags: new Set(this.state.tags) }; }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. PROJECTION — Read Model
// ─────────────────────────────────────────────────────────────────────────────

interface NoteReadModel {
  id: string;
  title: string;
  authorId: string;
  tags: string[];
  deleted: boolean;
  eventCount: number;
}

class NoteProjection {
  private models = new Map<string, NoteReadModel>();
  private position = 0;

  project(events: DomainEvent[]): void {
    for (const event of events.slice(this.position)) {
      this.position++;
      if (event.aggregateType !== "Note") continue;
      const ne = event as NoteEvent;
      const id = ne.aggregateId;

      switch (ne.type) {
        case "NoteCreated": {
          this.models.set(id, { id, title: ne.payload.title, authorId: ne.payload.authorId, tags: [], deleted: false, eventCount: 1 });
          break;
        }
        case "NoteTitled": {
          const m = this.models.get(id);
          if (m) { m.title = ne.payload.title; m.eventCount++; }
          break;
        }
        case "NoteTagged": {
          const m = this.models.get(id);
          if (m && !m.tags.includes(ne.payload.tag)) { m.tags.push(ne.payload.tag); m.eventCount++; }
          break;
        }
        case "NoteDeleted": {
          const m = this.models.get(id);
          if (m) { m.deleted = true; m.eventCount++; }
          break;
        }
      }
    }
  }

  findAll(includeDeleted = false): NoteReadModel[] {
    return [...this.models.values()].filter(m => includeDeleted || !m.deleted);
  }

  findById(id: string): NoteReadModel | null { return this.models.get(id) ?? null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. OUTBOX PATTERN
// ─────────────────────────────────────────────────────────────────────────────

interface OutboxEntry {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: string; // JSON
  status: "pending" | "dispatched";
  createdAt: string;
}

class OutboxPublisher {
  private entries: OutboxEntry[] = [];

  write(event: DomainEvent): void {
    this.entries.push({
      id: `out_${Date.now()}`,
      aggregateId: event.aggregateId,
      eventType:   event.type,
      payload:     JSON.stringify(event),
      status:      "pending",
      createdAt:   new Date().toISOString(),
    });
  }

  async publish(dispatcher: (entry: OutboxEntry) => Promise<void>): Promise<void> {
    const pending = this.entries.filter(e => e.status === "pending");
    for (const entry of pending) {
      await dispatcher(entry);
      entry.status = "dispatched";
    }
  }

  stats(): { pending: number; dispatched: number } {
    const pending    = this.entries.filter(e => e.status === "pending").length;
    const dispatched = this.entries.filter(e => e.status === "dispatched").length;
    return { pending, dispatched };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. SAGA PATTERN — Document Processing
// ─────────────────────────────────────────────────────────────────────────────

type DocumentSagaState =
  | { step: "idle" }
  | { step: "uploading"; documentId: string }
  | { step: "chunking"; documentId: string; totalChunks: number }
  | { step: "embedding"; documentId: string; processedChunks: number; totalChunks: number }
  | { step: "indexing"; documentId: string }
  | { step: "complete"; documentId: string; duration: number }
  | { step: "failed"; documentId: string; error: string; compensating: boolean };

interface DocumentServices {
  storage:     { upload(docName: string): Promise<string> };
  chunker:     { chunk(docId: string): Promise<string[]> };
  embedder:    { embed(chunks: string[]): Promise<number[][]> };
  vectorStore: { index(docId: string, embeddings: number[][]): Promise<void> };
  notifier:    { notify(docId: string, status: string): Promise<void> };
}

function createMockServices(): DocumentServices {
  return {
    storage: {
      async upload(docName: string): Promise<string> {
        return `doc_${docName.replace(/\s+/g, "_").toLowerCase()}`;
      },
    },
    chunker: {
      async chunk(_docId: string): Promise<string[]> {
        return ["chunk_1", "chunk_2", "chunk_3", "chunk_4"];
      },
    },
    embedder: {
      async embed(chunks: string[]): Promise<number[][]> {
        return chunks.map(() => [0.1, 0.2, 0.3]);
      },
    },
    vectorStore: {
      async index(_docId: string, _embeddings: number[][]): Promise<void> {
        // mock index
      },
    },
    notifier: {
      async notify(docId: string, status: string): Promise<void> {
        console.log(`    [Notifier] ${docId} → ${status}`);
      },
    },
  };
}

class DocumentProcessingSaga {
  private state: DocumentSagaState = { step: "idle" };
  private startTime = 0;

  constructor(private readonly services: DocumentServices) {}

  async execute(docName: string): Promise<string> {
    this.startTime = Date.now();
    let currentDocId = "";

    try {
      // Step 1: Upload
      this.state = { step: "uploading", documentId: "" };
      const documentId = await this.services.storage.upload(docName);
      currentDocId = documentId;
      this.state = { step: "uploading", documentId };

      // Step 2: Chunk
      this.state = { step: "chunking", documentId, totalChunks: 0 };
      const chunks = await this.services.chunker.chunk(documentId);
      this.state = { step: "chunking", documentId, totalChunks: chunks.length };

      // Step 3: Embed
      this.state = { step: "embedding", documentId, processedChunks: 0, totalChunks: chunks.length };
      const allEmbeddings: number[][] = [];
      const BATCH_SIZE = 20;
      for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
        const batch = chunks.slice(i, i + BATCH_SIZE);
        const embeddings = await this.services.embedder.embed(batch);
        allEmbeddings.push(...embeddings);
        this.state = {
          step: "embedding", documentId,
          processedChunks: Math.min(i + BATCH_SIZE, chunks.length),
          totalChunks: chunks.length,
        };
      }

      // Step 4: Index
      this.state = { step: "indexing", documentId };
      await this.services.vectorStore.index(documentId, allEmbeddings);

      // Complete
      const duration = Date.now() - this.startTime;
      this.state = { step: "complete", documentId, duration };
      await this.services.notifier.notify(documentId, "complete");
      return documentId;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.state = { step: "failed", documentId: currentDocId, error: errMsg, compensating: true };
      await this.compensate(currentDocId);
      this.state = { step: "failed", documentId: currentDocId, error: errMsg, compensating: false };
      throw error;
    }
  }

  private async compensate(documentId: string): Promise<void> {
    if (!documentId) return;
    console.log(`    [Saga] Compensating for ${documentId}`);
    await this.services.notifier.notify(documentId, "failed");
  }

  getProgress(): { step: string; percentage: number } {
    const s = this.state;
    switch (s.step) {
      case "idle":      return { step: "idle", percentage: 0 };
      case "uploading": return { step: "Uploading...", percentage: 10 };
      case "chunking":  return { step: "Chunking...", percentage: 25 };
      case "embedding": {
        const pct = s.totalChunks > 0 ? 25 + (s.processedChunks / s.totalChunks) * 60 : 25;
        return { step: `Embedding (${s.processedChunks}/${s.totalChunks})...`, percentage: pct };
      }
      case "indexing":  return { step: "Indexing...", percentage: 90 };
      case "complete":  return { step: "Complete!", percentage: 100 };
      case "failed":    return { step: s.compensating ? "Rolling back..." : `Failed: ${s.error}`, percentage: -1 };
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. PROJECTION MANAGER — Catch-up Subscription
// ─────────────────────────────────────────────────────────────────────────────

interface Projectable {
  project(events: DomainEvent[]): void;
}

class ProjectionManager {
  private position = 0;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly store: EventStore,
    private readonly projections: Projectable[],
  ) {}

  catchUp(): void {
    const events = this.store.getAll(this.position);
    if (events.length === 0) return;
    for (const proj of this.projections) {
      proj.project(events);
    }
    this.position += events.length;
  }

  startLive(): void {
    this.catchUp();
    const handler = (event: DomainEvent): void => {
      for (const proj of this.projections) {
        proj.project([event]);
      }
      this.position++;
    };
    this.store.on("appended", handler);
    this.unsubscribe = () => this.store.off("appended", handler);
  }

  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DEMO / RUN
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n══════════════════════════════════════");
  console.log(" Bài 7: Event Sourcing & CQRS");
  console.log("══════════════════════════════════════\n");

  const store = new EventStore();
  const outbox = new OutboxPublisher();

  store.on("appended", event => outbox.write(event));

  // ── Commands → Events ──
  console.log("[Aggregate Commands]");
  const note1 = NoteAggregate.create(store, "note_1", "usr_alice", "Draft", "Initial body");
  note1.addTag("typescript");
  note1.addTag("offline");
  note1.rename("Offline-First Notes");

  const note2 = NoteAggregate.create(store, "note_2", "usr_bob", "Bob's Idea", "...");
  note2.delete();

  console.log(`  note_1 version: ${note1.snapshot.version}, tags: [${[...note1.snapshot.tags].join(", ")}]`);
  console.log(`  note_2 deleted: ${note2.snapshot.deleted}`);

  // ── Event Stream ──
  const stream = store.getStream("note_1");
  console.log(`\n[Event Stream for note_1] (${stream.length} events):`);
  stream.forEach(e => console.log(`  v${e.version} ${e.type}`));

  // ── Aggregate Rehydration ──
  console.log("\n[Rehydration from event log]");
  const reloaded = NoteAggregate.load(store, "note_1");
  console.log(`  title: "${reloaded.snapshot.title}" version=${reloaded.snapshot.version}`);

  // ── Optimistic concurrency conflict ──
  console.log("\n[Optimistic Concurrency]");
  try {
    store.append({ type: "NoteTitled", aggregateId: "note_1", aggregateType: "Note", version: 2, payload: { title: "Conflict!" } });
  } catch (err) {
    console.log(`  ✅ Caught conflict: ${(err as Error).message}`);
  }

  // ── Projection Manager (catch-up + live) ──
  console.log("\n[Projection Manager — catch-up]");
  const projection = new NoteProjection();
  const manager = new ProjectionManager(store, [projection]);
  manager.catchUp();
  const notes = projection.findAll();
  notes.forEach(n => console.log(`  ${n.id}: "${n.title}" tags=[${n.tags.join(",")}] deleted=${n.deleted} events=${n.eventCount}`));

  console.log("\n[Projection Manager — live subscription]");
  manager.startLive();
  const note3 = NoteAggregate.create(store, "note_3", "usr_carol", "Live Note", "created while live");
  note3.addTag("live");
  const liveResult = projection.findById("note_3");
  console.log(`  Live projected note_3: "${liveResult?.title ?? "?"}" tags=[${liveResult?.tags.join(",") ?? ""}]`);
  manager.stop();

  // ── Saga ──
  console.log("\n[Saga — Document Processing]");
  const saga = new DocumentProcessingSaga(createMockServices());
  console.log(`  Before: ${saga.getProgress().step}`);
  const docId = await saga.execute("my_report.pdf");
  const progress = saga.getProgress();
  console.log(`  After: ${progress.step} (${progress.percentage}%) → docId=${docId}`);

  // ── Outbox ──
  console.log("\n[Outbox Pattern]");
  console.log("  Before publish:", outbox.stats());
  await outbox.publish(async (entry) => {
    console.log(`    → Dispatching ${entry.eventType} (${entry.aggregateId})`);
  });
  console.log("  After publish:", outbox.stats());

  console.log("\n✅ Bài 7 hoàn thành!\n");
}

main().catch(console.error);

export {};

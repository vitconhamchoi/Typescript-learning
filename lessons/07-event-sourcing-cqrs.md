# Bài 7: Event Sourcing & CQRS với TypeScript

## Mục tiêu bài học

- Implement Event Store từ đầu với TypeScript
- Xây dựng CQRS (Command Query Responsibility Segregation) cho AI systems
- Thiết kế Projections và Read Models cho real-time dashboards
- Implement Saga pattern cho multi-step AI workflows
- Outbox pattern để đảm bảo at-least-once delivery

---

## 7.1 Event Store Fundamentals

```typescript
// ============ CORE TYPES ============

// Domain events cho AI system
type AISystemEvent =
  | ConversationStarted
  | MessageAdded
  | ModelChanged
  | ConversationArchived
  | DocumentUploaded
  | EmbeddingsCreated
  | AIResponseGenerated
  | ToolCallExecuted
  | UserFeedbackGiven;

interface DomainEvent {
  id: string;
  type: string;
  aggregateId: string;
  aggregateType: string;
  version: number;           // Position within aggregate stream
  globalPosition: number;    // Global position across all streams
  occurredAt: Date;
  payload: Record<string, unknown>;
  metadata: EventMetadata;
}

interface EventMetadata {
  userId?: string;
  correlationId: string;   // Traces related events
  causationId: string;     // ID of event/command that caused this
  sessionId?: string;
  clientVersion?: string;
}

// Specific events
interface ConversationStarted extends DomainEvent {
  type: "ConversationStarted";
  aggregateType: "Conversation";
  payload: {
    userId: string;
    modelId: string;
    systemPrompt: string;
    title: string;
  };
}

interface MessageAdded extends DomainEvent {
  type: "MessageAdded";
  aggregateType: "Conversation";
  payload: {
    messageId: string;
    role: "user" | "assistant" | "system" | "tool";
    content: string;
    tokenCount: number;
    model?: string;
  };
}

interface ModelChanged extends DomainEvent {
  type: "ModelChanged";
  aggregateType: "Conversation";
  payload: {
    previousModelId: string;
    newModelId: string;
    reason?: string;
  };
}

interface ConversationArchived extends DomainEvent {
  type: "ConversationArchived";
  aggregateType: "Conversation";
  payload: { reason?: string };
}

interface DocumentUploaded extends DomainEvent {
  type: "DocumentUploaded";
  aggregateType: "KnowledgeBase";
  payload: {
    documentId: string;
    filename: string;
    mimeType: string;
    size: number;
    chunkCount: number;
  };
}

interface EmbeddingsCreated extends DomainEvent {
  type: "EmbeddingsCreated";
  aggregateType: "KnowledgeBase";
  payload: {
    documentId: string;
    embeddingModel: string;
    chunkCount: number;
    dimensions: number;
  };
}

interface AIResponseGenerated extends DomainEvent {
  type: "AIResponseGenerated";
  aggregateType: "Conversation";
  payload: {
    messageId: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    latencyMs: number;
    finishReason: string;
  };
}

interface ToolCallExecuted extends DomainEvent {
  type: "ToolCallExecuted";
  aggregateType: "Conversation";
  payload: {
    toolCallId: string;
    toolName: string;
    arguments: Record<string, unknown>;
    result: unknown;
    durationMs: number;
    success: boolean;
  };
}

interface UserFeedbackGiven extends DomainEvent {
  type: "UserFeedbackGiven";
  aggregateType: "Conversation";
  payload: {
    messageId: string;
    rating: "positive" | "negative";
    comment?: string;
  };
}
```

---

## 7.2 Event Store Implementation

```typescript
// In-memory Event Store (use EventStoreDB/PostgreSQL in production)
class EventStore {
  private streams: Map<string, DomainEvent[]> = new Map();
  private globalLog: DomainEvent[] = [];
  private subscriptions: Map<string, Set<EventSubscriber>> = new Map();
  private globalPosition = 0;

  async append(
    streamId: string,
    events: Omit<DomainEvent, "id" | "globalPosition" | "version">[],
    expectedVersion: number | "any" | "no-stream"
  ): Promise<void> {
    const stream = this.streams.get(streamId) ?? [];
    
    // Optimistic concurrency check
    if (expectedVersion !== "any") {
      const currentVersion = stream.length;
      if (expectedVersion === "no-stream" && currentVersion > 0) {
        throw new ConcurrencyError(streamId, "no-stream", currentVersion);
      }
      if (typeof expectedVersion === "number" && currentVersion !== expectedVersion) {
        throw new ConcurrencyError(streamId, expectedVersion, currentVersion);
      }
    }

    const appendedEvents: DomainEvent[] = events.map((event, idx) => ({
      ...event,
      id: crypto.randomUUID(),
      version: stream.length + idx + 1,
      globalPosition: ++this.globalPosition,
    }));

    if (!this.streams.has(streamId)) {
      this.streams.set(streamId, []);
    }
    this.streams.get(streamId)!.push(...appendedEvents);
    this.globalLog.push(...appendedEvents);

    // Notify subscribers
    for (const event of appendedEvents) {
      await this.notify(event);
    }
  }

  async readStream(
    streamId: string,
    options: { fromVersion?: number; toVersion?: number; maxCount?: number } = {}
  ): Promise<DomainEvent[]> {
    const stream = this.streams.get(streamId) ?? [];
    let events = stream;

    if (options.fromVersion !== undefined) {
      events = events.filter((e) => e.version >= options.fromVersion!);
    }
    if (options.toVersion !== undefined) {
      events = events.filter((e) => e.version <= options.toVersion!);
    }
    if (options.maxCount !== undefined) {
      events = events.slice(0, options.maxCount);
    }

    return events;
  }

  async readAll(
    options: { fromPosition?: number; eventTypes?: string[]; maxCount?: number } = {}
  ): Promise<DomainEvent[]> {
    let events = this.globalLog;

    if (options.fromPosition !== undefined) {
      events = events.filter((e) => e.globalPosition > options.fromPosition!);
    }
    if (options.eventTypes) {
      events = events.filter((e) => options.eventTypes!.includes(e.type));
    }
    if (options.maxCount !== undefined) {
      events = events.slice(0, options.maxCount);
    }

    return events;
  }

  subscribe(
    subscriberId: string,
    eventTypes: string[],
    handler: EventSubscriber
  ): () => void {
    for (const eventType of eventTypes) {
      if (!this.subscriptions.has(eventType)) {
        this.subscriptions.set(eventType, new Set());
      }
      this.subscriptions.get(eventType)!.add(handler);
    }

    return () => {
      for (const eventType of eventTypes) {
        this.subscriptions.get(eventType)?.delete(handler);
      }
    };
  }

  private async notify(event: DomainEvent): Promise<void> {
    const handlers = this.subscriptions.get(event.type) ?? new Set();
    const allHandlers = this.subscriptions.get("*") ?? new Set();
    
    await Promise.all([
      ...[...handlers].map((h) => h(event)),
      ...[...allHandlers].map((h) => h(event)),
    ]);
  }

  streamLength(streamId: string): number {
    return this.streams.get(streamId)?.length ?? 0;
  }
}

type EventSubscriber = (event: DomainEvent) => Promise<void>;

class ConcurrencyError extends Error {
  constructor(
    public streamId: string,
    public expectedVersion: number | "no-stream",
    public actualVersion: number
  ) {
    super(
      `Concurrency conflict on stream ${streamId}: expected ${expectedVersion}, got ${actualVersion}`
    );
    this.name = "ConcurrencyError";
  }
}
```

---

## 7.3 Aggregate Pattern

```typescript
// Base aggregate class
abstract class AggregateRoot {
  protected version = 0;
  private uncommittedEvents: DomainEvent[] = [];

  constructor(protected id: string) {}

  protected apply(
    event: Omit<DomainEvent, "id" | "globalPosition" | "version">
  ): void {
    const fullEvent: DomainEvent = {
      ...event,
      id: crypto.randomUUID(),
      version: this.version + 1,
      globalPosition: 0, // Set by EventStore on commit
    };
    this.handleEvent(fullEvent);
    this.uncommittedEvents.push(fullEvent);
    this.version++;
  }

  protected abstract handleEvent(event: DomainEvent): void;

  getUncommittedEvents(): DomainEvent[] {
    return [...this.uncommittedEvents];
  }

  clearUncommittedEvents(): void {
    this.uncommittedEvents = [];
  }

  rehydrate(events: DomainEvent[]): void {
    for (const event of events) {
      this.handleEvent(event);
      this.version = event.version;
    }
  }

  getVersion(): number {
    return this.version;
  }
}

// Conversation Aggregate
class ConversationAggregate extends AggregateRoot {
  private userId!: string;
  private modelId!: string;
  private systemPrompt!: string;
  private title!: string;
  private messages: Array<{
    id: string;
    role: string;
    content: string;
    tokenCount: number;
  }> = [];
  private isArchived = false;
  private totalTokens = 0;

  static create(
    id: string,
    params: {
      userId: string;
      modelId: string;
      systemPrompt: string;
      title: string;
      correlationId: string;
    }
  ): ConversationAggregate {
    const conv = new ConversationAggregate(id);
    conv.apply({
      type: "ConversationStarted",
      aggregateId: id,
      aggregateType: "Conversation",
      occurredAt: new Date(),
      payload: {
        userId: params.userId,
        modelId: params.modelId,
        systemPrompt: params.systemPrompt,
        title: params.title,
      },
      metadata: {
        correlationId: params.correlationId,
        causationId: params.correlationId,
        userId: params.userId,
      },
    });
    return conv;
  }

  addMessage(params: {
    messageId: string;
    role: "user" | "assistant" | "system" | "tool";
    content: string;
    tokenCount: number;
    model?: string;
    correlationId: string;
  }): void {
    if (this.isArchived) {
      throw new Error("Cannot add message to archived conversation");
    }

    this.apply({
      type: "MessageAdded",
      aggregateId: this.id,
      aggregateType: "Conversation",
      occurredAt: new Date(),
      payload: params,
      metadata: {
        correlationId: params.correlationId,
        causationId: params.correlationId,
      },
    });
  }

  changeModel(params: {
    newModelId: string;
    reason?: string;
    correlationId: string;
  }): void {
    if (this.modelId === params.newModelId) return;
    
    this.apply({
      type: "ModelChanged",
      aggregateId: this.id,
      aggregateType: "Conversation",
      occurredAt: new Date(),
      payload: {
        previousModelId: this.modelId,
        newModelId: params.newModelId,
        reason: params.reason,
      },
      metadata: {
        correlationId: params.correlationId,
        causationId: params.correlationId,
      },
    });
  }

  archive(correlationId: string): void {
    if (this.isArchived) return;
    
    this.apply({
      type: "ConversationArchived",
      aggregateId: this.id,
      aggregateType: "Conversation",
      occurredAt: new Date(),
      payload: {},
      metadata: {
        correlationId,
        causationId: correlationId,
      },
    });
  }

  protected handleEvent(event: DomainEvent): void {
    switch (event.type) {
      case "ConversationStarted": {
        const p = event.payload as ConversationStarted["payload"];
        this.userId = p.userId;
        this.modelId = p.modelId;
        this.systemPrompt = p.systemPrompt;
        this.title = p.title;
        break;
      }
      case "MessageAdded": {
        const p = event.payload as MessageAdded["payload"];
        this.messages.push({
          id: p.messageId,
          role: p.role,
          content: p.content,
          tokenCount: p.tokenCount,
        });
        this.totalTokens += p.tokenCount;
        break;
      }
      case "ModelChanged": {
        const p = event.payload as ModelChanged["payload"];
        this.modelId = p.newModelId;
        break;
      }
      case "ConversationArchived":
        this.isArchived = true;
        break;
    }
  }

  // Getters
  getState() {
    return {
      id: this.id,
      userId: this.userId,
      modelId: this.modelId,
      systemPrompt: this.systemPrompt,
      title: this.title,
      messages: this.messages,
      isArchived: this.isArchived,
      totalTokens: this.totalTokens,
      version: this.version,
    };
  }
}

// Repository for aggregates
class ConversationRepository {
  constructor(private eventStore: EventStore) {}

  async save(conversation: ConversationAggregate): Promise<void> {
    const events = conversation.getUncommittedEvents();
    if (events.length === 0) return;

    const expectedVersion =
      conversation.getVersion() - events.length; // version before uncommitted events

    await this.eventStore.append(
      `conversation-${conversation["id"]}`,
      events,
      expectedVersion === 0 ? "no-stream" : expectedVersion
    );

    conversation.clearUncommittedEvents();
  }

  async load(conversationId: string): Promise<ConversationAggregate | null> {
    const events = await this.eventStore.readStream(
      `conversation-${conversationId}`
    );

    if (events.length === 0) return null;

    const conversation = new ConversationAggregate(conversationId);
    conversation.rehydrate(events);
    return conversation;
  }
}
```

---

## 7.4 CQRS — Projections & Read Models

```typescript
// Read models for fast queries
interface ConversationSummary {
  id: string;
  userId: string;
  title: string;
  modelId: string;
  messageCount: number;
  totalTokens: number;
  isArchived: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastMessagePreview: string;
}

interface UserStats {
  userId: string;
  totalConversations: number;
  totalMessages: number;
  totalTokens: number;
  favoriteModel: string;
  averageMessagesPerConversation: number;
  lastActiveAt: Date;
}

// Projection: builds read models from events
class ConversationProjection {
  private summaries: Map<string, ConversationSummary> = new Map();
  private userStats: Map<string, UserStats> = new Map();

  async handleEvent(event: DomainEvent): Promise<void> {
    switch (event.type) {
      case "ConversationStarted":
        await this.onConversationStarted(event as ConversationStarted);
        break;
      case "MessageAdded":
        await this.onMessageAdded(event as MessageAdded);
        break;
      case "ModelChanged":
        await this.onModelChanged(event as ModelChanged);
        break;
      case "ConversationArchived":
        await this.onConversationArchived(event as ConversationArchived);
        break;
    }
  }

  private async onConversationStarted(event: ConversationStarted): Promise<void> {
    this.summaries.set(event.aggregateId, {
      id: event.aggregateId,
      userId: event.payload.userId,
      title: event.payload.title,
      modelId: event.payload.modelId,
      messageCount: 0,
      totalTokens: 0,
      isArchived: false,
      createdAt: event.occurredAt,
      updatedAt: event.occurredAt,
      lastMessagePreview: "",
    });

    const stats = this.getUserStats(event.payload.userId);
    stats.totalConversations++;
    stats.lastActiveAt = event.occurredAt;
  }

  private async onMessageAdded(event: MessageAdded): Promise<void> {
    const summary = this.summaries.get(event.aggregateId);
    if (!summary) return;

    summary.messageCount++;
    summary.totalTokens += event.payload.tokenCount;
    summary.updatedAt = event.occurredAt;
    summary.lastMessagePreview = event.payload.content.slice(0, 100);

    const stats = this.getUserStats(summary.userId);
    stats.totalMessages++;
    stats.totalTokens += event.payload.tokenCount;
    stats.lastActiveAt = event.occurredAt;
    stats.averageMessagesPerConversation =
      stats.totalMessages / stats.totalConversations;
  }

  private async onModelChanged(event: ModelChanged): Promise<void> {
    const summary = this.summaries.get(event.aggregateId);
    if (!summary) return;
    summary.modelId = event.payload.newModelId;
    summary.updatedAt = event.occurredAt;
  }

  private async onConversationArchived(event: ConversationArchived): Promise<void> {
    const summary = this.summaries.get(event.aggregateId);
    if (!summary) return;
    summary.isArchived = true;
    summary.updatedAt = event.occurredAt;
  }

  private getUserStats(userId: string): UserStats {
    if (!this.userStats.has(userId)) {
      this.userStats.set(userId, {
        userId,
        totalConversations: 0,
        totalMessages: 0,
        totalTokens: 0,
        favoriteModel: "",
        averageMessagesPerConversation: 0,
        lastActiveAt: new Date(),
      });
    }
    return this.userStats.get(userId)!;
  }

  // Query methods
  getConversationsByUser(userId: string, includeArchived = false): ConversationSummary[] {
    return Array.from(this.summaries.values())
      .filter((s) => s.userId === userId && (includeArchived || !s.isArchived))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }

  getUserStats(userId: string): UserStats {
    return this.userStats.get(userId) ?? {
      userId,
      totalConversations: 0,
      totalMessages: 0,
      totalTokens: 0,
      favoriteModel: "",
      averageMessagesPerConversation: 0,
      lastActiveAt: new Date(),
    };
  }
}

// Projection manager with catch-up subscription
class ProjectionManager {
  private position = 0;

  constructor(
    private eventStore: EventStore,
    private projections: Array<{ handleEvent: (event: DomainEvent) => Promise<void> }>
  ) {}

  async catchUp(): Promise<void> {
    const events = await this.eventStore.readAll({
      fromPosition: this.position,
    });

    for (const event of events) {
      await this.processEvent(event);
      this.position = event.globalPosition;
    }
  }

  async startLiveProjection(): Promise<() => void> {
    // First catch up to current position
    await this.catchUp();

    // Then subscribe to live events
    return this.eventStore.subscribe("projection-manager", ["*"], async (event) => {
      if (event.globalPosition > this.position) {
        await this.processEvent(event);
        this.position = event.globalPosition;
      }
    });
  }

  private async processEvent(event: DomainEvent): Promise<void> {
    await Promise.all(
      this.projections.map((p) =>
        p.handleEvent(event).catch((err) =>
          console.error(`Projection error for event ${event.id}:`, err)
        )
      )
    );
  }
}
```

---

## 7.5 Saga Pattern cho AI Workflows

```typescript
// Saga for multi-step AI document processing
type DocumentProcessingSagaState =
  | { step: "idle" }
  | { step: "uploading"; documentId: string }
  | { step: "chunking"; documentId: string; totalChunks: number }
  | { step: "embedding"; documentId: string; processedChunks: number; totalChunks: number }
  | { step: "indexing"; documentId: string }
  | { step: "complete"; documentId: string; duration: number }
  | { step: "failed"; documentId: string; error: string; compensating: boolean };

class DocumentProcessingSaga {
  private state: DocumentProcessingSagaState = { step: "idle" };
  private startTime = 0;

  constructor(
    private services: {
      storage: { upload(file: File): Promise<string> };
      chunker: { chunk(docId: string): Promise<string[]> };
      embedder: { embed(chunks: string[]): Promise<number[][]> };
      vectorStore: { index(docId: string, embeddings: number[][]): Promise<void> };
      notifier: { notify(docId: string, status: string): Promise<void> };
    }
  ) {}

  async execute(file: File): Promise<string> {
    this.startTime = Date.now();

    try {
      // Step 1: Upload
      this.state = { step: "uploading", documentId: "" };
      const documentId = await this.services.storage.upload(file);
      this.state = { step: "uploading", documentId };

      // Step 2: Chunk
      this.state = { step: "chunking", documentId, totalChunks: 0 };
      const chunks = await this.services.chunker.chunk(documentId);
      this.state = { step: "chunking", documentId, totalChunks: chunks.length };

      // Step 3: Embed (batch processing)
      this.state = {
        step: "embedding",
        documentId,
        processedChunks: 0,
        totalChunks: chunks.length,
      };

      const BATCH_SIZE = 20;
      const allEmbeddings: number[][] = [];
      for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
        const batch = chunks.slice(i, i + BATCH_SIZE);
        const embeddings = await this.services.embedder.embed(batch);
        allEmbeddings.push(...embeddings);
        this.state = {
          step: "embedding",
          documentId,
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
      const docId =
        "documentId" in this.state ? (this.state as { documentId: string }).documentId : "";

      this.state = {
        step: "failed",
        documentId: docId,
        error: errMsg,
        compensating: true,
      };

      // Compensating transactions (cleanup on failure)
      await this.compensate(docId);

      this.state = { ...this.state, compensating: false };
      throw error;
    }
  }

  private async compensate(documentId: string): Promise<void> {
    if (!documentId) return;
    
    console.log(`Running compensation for document ${documentId}`);
    // Delete uploaded file, embeddings, etc.
    await this.services.notifier.notify(documentId, "failed");
  }

  getProgress(): { step: string; percentage: number } {
    const state = this.state;
    switch (state.step) {
      case "idle":
        return { step: "idle", percentage: 0 };
      case "uploading":
        return { step: "Uploading...", percentage: 10 };
      case "chunking":
        return { step: "Chunking document...", percentage: 25 };
      case "embedding":
        return {
          step: `Embedding chunks (${state.processedChunks}/${state.totalChunks})...`,
          percentage: 25 + (state.processedChunks / state.totalChunks) * 60,
        };
      case "indexing":
        return { step: "Indexing embeddings...", percentage: 90 };
      case "complete":
        return { step: "Complete!", percentage: 100 };
      case "failed":
        return {
          step: state.compensating ? "Rolling back..." : `Failed: ${state.error}`,
          percentage: -1,
        };
    }
  }
}
```

---

## 7.6 Outbox Pattern — Reliable Event Publishing

```typescript
// Outbox ensures events are published even if service crashes
interface OutboxEntry {
  id: string;
  eventType: string;
  payload: string; // JSON
  destination: string;
  createdAt: Date;
  publishedAt: Date | null;
  retryCount: number;
  maxRetries: number;
  error: string | null;
}

class OutboxProcessor {
  private processing = false;

  constructor(
    private outboxStore: {
      findPending(): Promise<OutboxEntry[]>;
      markPublished(id: string): Promise<void>;
      markFailed(id: string, error: string): Promise<void>;
      incrementRetry(id: string): Promise<void>;
    },
    private publisher: {
      publish(destination: string, eventType: string, payload: unknown): Promise<void>;
    }
  ) {}

  async process(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      const pending = await this.outboxStore.findPending();
      
      for (const entry of pending) {
        try {
          await this.publisher.publish(
            entry.destination,
            entry.eventType,
            JSON.parse(entry.payload)
          );
          await this.outboxStore.markPublished(entry.id);
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          await this.outboxStore.incrementRetry(entry.id);
          
          if (entry.retryCount >= entry.maxRetries) {
            await this.outboxStore.markFailed(entry.id, errMsg);
          }
        }
      }
    } finally {
      this.processing = false;
    }
  }

  startPolling(intervalMs: number = 1000): () => void {
    const interval = setInterval(() => this.process(), intervalMs);
    return () => clearInterval(interval);
  }
}
```

---

## Tóm tắt Bài 7

| Pattern | TypeScript Pattern | AI Use Case |
|---------|-------------------|-------------|
| Event Store | Class + Map | Immutable conversation history |
| Aggregate | Abstract class + rehydrate | Conversation domain logic |
| CQRS | Separate read/write models | Fast dashboards + reliable writes |
| Projection | Event handlers + Map | Real-time user stats |
| Saga | State machine + compensation | Document processing pipeline |
| Outbox | Queue + polling processor | Reliable webhook delivery |

## Bài tập thực hành

1. Implement **Snapshot Strategy**: khi conversation có >100 events, tạo snapshot để tránh replay toàn bộ history.
2. Xây dựng **Cost Tracking Projection**: tính toán token cost per user per day từ `AIResponseGenerated` events.
3. Implement **Process Manager** (Advanced Saga): orchestrate multi-service AI workflow với compensation transactions.

---

*Tiếp theo: [Bài 8 — AI Gateway Design](08-ai-gateway-design.md)*

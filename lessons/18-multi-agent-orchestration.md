# Bài 18: Multi-Agent Orchestration với TypeScript

## Mục tiêu bài học

- Thiết kế multi-agent systems: hierarchical và peer-to-peer
- Implement Agent Communication Protocol type-safe
- Orchestrator pattern cho complex AI workflows
- Agent specialization và role assignment
- Consensus và voting mechanisms

---

## 18.1 Multi-Agent Communication Protocol

```typescript
// Agent message types
type AgentMessageType =
  | "task_assignment"
  | "task_result"
  | "task_error"
  | "status_update"
  | "request_help"
  | "broadcast"
  | "consensus_vote"
  | "consensus_result";

interface AgentMessage {
  id: string;
  type: AgentMessageType;
  senderId: string;
  recipientId: string | "broadcast";
  correlationId: string;       // For request-response correlation
  payload: unknown;
  priority: "low" | "normal" | "high" | "critical";
  timestamp: Date;
  ttl: number;                 // Time-to-live in ms
}

interface TaskAssignment {
  taskId: string;
  description: string;
  input: unknown;
  deadline: Date;
  requirements: string[];
  parentTaskId?: string;
}

interface TaskResult {
  taskId: string;
  success: boolean;
  output: unknown;
  tokensUsed: number;
  durationMs: number;
  agentId: string;
}

// Message bus for agent communication
class AgentMessageBus {
  private subscribers = new Map<string, Set<(message: AgentMessage) => Promise<void>>>();
  private messageLog: AgentMessage[] = [];
  private deliveryTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

  async publish(message: AgentMessage): Promise<void> {
    this.messageLog.push(message);

    const recipients =
      message.recipientId === "broadcast"
        ? Array.from(this.subscribers.keys())
        : [message.recipientId];

    const deliveries = recipients.map(async (recipientId) => {
      const handlers = this.subscribers.get(recipientId) ?? new Set();
      await Promise.all([...handlers].map((h) => h(message)));
    });

    await Promise.all(deliveries);

    // Set TTL
    if (message.ttl > 0) {
      const timeout = setTimeout(() => {
        this.deliveryTimeouts.delete(message.id);
      }, message.ttl);
      this.deliveryTimeouts.set(message.id, timeout);
    }
  }

  subscribe(
    agentId: string,
    handler: (message: AgentMessage) => Promise<void>
  ): () => void {
    if (!this.subscribers.has(agentId)) {
      this.subscribers.set(agentId, new Set());
    }
    this.subscribers.get(agentId)!.add(handler);
    return () => this.subscribers.get(agentId)?.delete(handler);
  }

  getMessageHistory(
    filters?: { senderId?: string; recipientId?: string; type?: AgentMessageType }
  ): AgentMessage[] {
    return this.messageLog.filter((m) => {
      if (filters?.senderId && m.senderId !== filters.senderId) return false;
      if (filters?.recipientId && m.recipientId !== filters.recipientId) return false;
      if (filters?.type && m.type !== filters.type) return false;
      return true;
    });
  }
}
```

---

## 18.2 Specialized Agent Roles

```typescript
// Base agent class
abstract class BaseAgent {
  protected isRunning = false;
  private unsubscribe: (() => void) | null = null;

  constructor(
    protected id: string,
    protected name: string,
    protected role: string,
    protected bus: AgentMessageBus,
    protected llm: {
      complete(messages: Array<{ role: string; content: string }>): Promise<{
        content: string;
        usage: { promptTokens: number; completionTokens: number };
      }>;
    }
  ) {}

  start(): void {
    this.isRunning = true;
    this.unsubscribe = this.bus.subscribe(this.id, (msg) => this.handleMessage(msg));
    this.unsubscribe = this.bus.subscribe("broadcast", (msg) => this.handleBroadcast(msg));
    console.log(`[Agent:${this.name}] Started`);
  }

  stop(): void {
    this.isRunning = false;
    this.unsubscribe?.();
    console.log(`[Agent:${this.name}] Stopped`);
  }

  protected async handleMessage(message: AgentMessage): Promise<void> {
    switch (message.type) {
      case "task_assignment":
        await this.onTaskAssigned(message.payload as TaskAssignment, message);
        break;
      case "request_help":
        await this.onHelpRequested(message.payload as string, message);
        break;
      case "consensus_vote":
        await this.onConsensusVoteRequested(message.payload as ConsensusRequest, message);
        break;
    }
  }

  protected async handleBroadcast(message: AgentMessage): Promise<void> {
    if (message.senderId === this.id) return; // Ignore own broadcasts
    if (message.type === "broadcast") {
      console.log(`[Agent:${this.name}] Broadcast from ${message.senderId}: ${JSON.stringify(message.payload)}`);
    }
  }

  protected abstract onTaskAssigned(task: TaskAssignment, message: AgentMessage): Promise<void>;
  
  protected async onHelpRequested(question: string, message: AgentMessage): Promise<void> {
    const response = await this.llm.complete([
      { role: "system", content: `You are ${this.name}, specialized in ${this.role}. Answer briefly.` },
      { role: "user", content: question },
    ]);

    await this.bus.publish({
      id: crypto.randomUUID(),
      type: "task_result",
      senderId: this.id,
      recipientId: message.senderId,
      correlationId: message.id,
      payload: { answer: response.content },
      priority: "normal",
      timestamp: new Date(),
      ttl: 30000,
    });
  }

  protected async onConsensusVoteRequested(
    request: ConsensusRequest,
    message: AgentMessage
  ): Promise<void> {
    const response = await this.llm.complete([
      {
        role: "system",
        content: `You are ${this.name}. Vote on this proposal from your ${this.role} perspective.
Return JSON: {"vote": "approve"|"reject", "reasoning": "..."}`,
      },
      { role: "user", content: request.proposal },
    ]);

    try {
      const vote = JSON.parse(response.content) as { vote: string; reasoning: string };
      await this.bus.publish({
        id: crypto.randomUUID(),
        type: "consensus_vote",
        senderId: this.id,
        recipientId: message.senderId,
        correlationId: message.correlationId,
        payload: {
          requestId: request.id,
          agentId: this.id,
          vote: vote.vote,
          reasoning: vote.reasoning,
        },
        priority: "high",
        timestamp: new Date(),
        ttl: 30000,
      });
    } catch {
      // Skip invalid vote
    }
  }

  protected async sendResult(
    task: TaskAssignment,
    result: unknown,
    message: AgentMessage
  ): Promise<void> {
    await this.bus.publish({
      id: crypto.randomUUID(),
      type: "task_result",
      senderId: this.id,
      recipientId: message.senderId,
      correlationId: message.id,
      payload: {
        taskId: task.taskId,
        success: true,
        output: result,
        agentId: this.id,
      } as TaskResult,
      priority: message.priority,
      timestamp: new Date(),
      ttl: 60000,
    });
  }
}

interface ConsensusRequest {
  id: string;
  proposal: string;
  requiredVotes: number;
}

// Specialized research agent
class ResearchAgent extends BaseAgent {
  constructor(bus: AgentMessageBus, llm: BaseAgent["llm"]) {
    super(
      `research-${crypto.randomUUID().slice(0, 8)}`,
      "Research Agent",
      "web research and information gathering",
      bus,
      llm
    );
  }

  protected async onTaskAssigned(task: TaskAssignment, message: AgentMessage): Promise<void> {
    console.log(`[ResearchAgent] Working on: ${task.description}`);

    const response = await this.llm.complete([
      {
        role: "system",
        content: `You are a research specialist. Gather and synthesize information for: ${task.description}
Input data: ${JSON.stringify(task.input)}
Provide a comprehensive research summary.`,
      },
      { role: "user", content: task.description },
    ]);

    await this.sendResult(task, {
      research: response.content,
      sources: [], // Would include actual sources
      confidence: 0.85,
    }, message);
  }
}

// Specialized coding agent
class CodingAgent extends BaseAgent {
  constructor(bus: AgentMessageBus, llm: BaseAgent["llm"]) {
    super(
      `coding-${crypto.randomUUID().slice(0, 8)}`,
      "Coding Agent",
      "software development and code generation",
      bus,
      llm
    );
  }

  protected async onTaskAssigned(task: TaskAssignment, message: AgentMessage): Promise<void> {
    console.log(`[CodingAgent] Working on: ${task.description}`);

    const response = await this.llm.complete([
      {
        role: "system",
        content: `You are a TypeScript expert. Write clean, type-safe code for: ${task.description}
Requirements: ${task.requirements.join(", ")}
Return a complete, working solution with explanations.`,
      },
      { role: "user", content: task.description },
    ]);

    await this.sendResult(task, {
      code: response.content,
      language: "typescript",
      testable: true,
    }, message);
  }
}

// Review agent with quality assurance
class ReviewAgent extends BaseAgent {
  constructor(bus: AgentMessageBus, llm: BaseAgent["llm"]) {
    super(
      `review-${crypto.randomUUID().slice(0, 8)}`,
      "Review Agent",
      "quality assurance and code review",
      bus,
      llm
    );
  }

  protected async onTaskAssigned(task: TaskAssignment, message: AgentMessage): Promise<void> {
    const { codeOutput, researchOutput } = task.input as {
      codeOutput?: { code: string };
      researchOutput?: { research: string };
    };

    const reviewTarget = codeOutput?.code ?? researchOutput?.research ?? JSON.stringify(task.input);

    const response = await this.llm.complete([
      {
        role: "system",
        content: `You are a senior reviewer. Critically evaluate this and provide:
1. Quality score (0-10)
2. Issues found
3. Specific improvements
4. Final verdict (approve/revise)
Return as JSON.`,
      },
      { role: "user", content: reviewTarget.slice(0, 3000) },
    ]);

    let review: unknown;
    try {
      review = JSON.parse(response.content);
    } catch {
      review = { score: 7, verdict: "approve", feedback: response.content };
    }

    await this.sendResult(task, review, message);
  }
}
```

---

## 18.3 Orchestrator Agent

```typescript
// Hierarchical orchestrator
class OrchestratorAgent extends BaseAgent {
  private pendingTasks = new Map<string, {
    task: TaskAssignment;
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
    assignedTo: string;
    timeout: ReturnType<typeof setTimeout>;
  }>();

  constructor(
    bus: AgentMessageBus,
    llm: BaseAgent["llm"],
    private agents: BaseAgent[],
    private agentRegistry: Map<string, { specialization: string; id: string }>
  ) {
    super(
      "orchestrator",
      "Orchestrator",
      "task decomposition and agent coordination",
      bus,
      llm
    );
  }

  protected async onTaskAssigned(task: TaskAssignment, message: AgentMessage): Promise<void> {
    console.log(`[Orchestrator] Received complex task: ${task.description}`);

    // Decompose into subtasks
    const plan = await this.decomposeTask(task);

    // Execute subtasks in dependency order
    const results: Record<string, unknown> = {};

    for (const subtask of plan.subtasks) {
      // Wait for dependencies
      const deps = subtask.dependsOn ?? [];
      for (const dep of deps) {
        if (!results[dep]) {
          throw new Error(`Dependency ${dep} not yet completed`);
        }
      }

      // Assign to appropriate agent
      const agentId = this.selectAgent(subtask.requiredSpecialization);
      if (!agentId) {
        throw new Error(`No agent available for: ${subtask.requiredSpecialization}`);
      }

      const result = await this.assignTask(agentId, {
        ...subtask,
        input: { ...subtask.input, dependencies: results },
      });

      results[subtask.taskId] = result;
    }

    // Synthesize final result
    const finalResult = await this.synthesizeResults(task, results);
    await this.sendResult(task, finalResult, message);
  }

  private async decomposeTask(task: TaskAssignment): Promise<{
    subtasks: Array<TaskAssignment & { requiredSpecialization: string; dependsOn?: string[] }>;
  }> {
    const agentCapabilities = Array.from(this.agentRegistry.values())
      .map((a) => `- ${a.specialization} (id: ${a.id})`)
      .join("\n");

    const response = await this.llm.complete([
      {
        role: "system",
        content: `You are a project manager. Decompose this task into subtasks.
Available agents:
${agentCapabilities}

Return JSON: {
  "subtasks": [{
    "taskId": "unique-id",
    "description": "...",
    "requiredSpecialization": "...",
    "requirements": [],
    "dependsOn": ["other-task-id"],
    "deadline": "ISO date",
    "input": {}
  }]
}`,
      },
      { role: "user", content: task.description },
    ]);

    try {
      return JSON.parse(response.content);
    } catch {
      // Single task fallback
      return {
        subtasks: [{
          ...task,
          taskId: crypto.randomUUID(),
          requiredSpecialization: "general",
        }],
      };
    }
  }

  private selectAgent(specialization: string): string | null {
    for (const [id, info] of this.agentRegistry) {
      if (info.specialization.toLowerCase().includes(specialization.toLowerCase())) {
        return id;
      }
    }
    // Fallback: first available agent
    const first = this.agentRegistry.keys().next();
    return first.done ? null : first.value;
  }

  private assignTask(agentId: string, task: TaskAssignment): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const taskTimeout = setTimeout(() => {
        this.pendingTasks.delete(task.taskId);
        reject(new Error(`Task ${task.taskId} timed out`));
      }, 120000);

      this.pendingTasks.set(task.taskId, {
        task,
        resolve,
        reject,
        assignedTo: agentId,
        timeout: taskTimeout,
      });

      this.bus.publish({
        id: crypto.randomUUID(),
        type: "task_assignment",
        senderId: this.id,
        recipientId: agentId,
        correlationId: task.taskId,
        payload: task,
        priority: "normal",
        timestamp: new Date(),
        ttl: 120000,
      });
    });
  }

  protected override async handleMessage(message: AgentMessage): Promise<void> {
    if (message.type === "task_result") {
      const result = message.payload as TaskResult;
      const pending = this.pendingTasks.get(result.taskId);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingTasks.delete(result.taskId);
        if (result.success) {
          pending.resolve(result.output);
        } else {
          pending.reject(new Error(`Task failed: ${JSON.stringify(result.output)}`));
        }
      }
    } else {
      await super.handleMessage(message);
    }
  }

  private async synthesizeResults(
    task: TaskAssignment,
    results: Record<string, unknown>
  ): Promise<string> {
    const response = await this.llm.complete([
      {
        role: "system",
        content: `You are a senior analyst. Synthesize these subtask results into a comprehensive answer.`,
      },
      {
        role: "user",
        content: `Original task: ${task.description}\n\nResults:\n${JSON.stringify(results, null, 2)}`,
      },
    ]);
    return response.content;
  }
}
```

---

## 18.4 Consensus Mechanism

```typescript
// Byzantine fault-tolerant voting
class ConsensusCoordinator {
  constructor(
    private bus: AgentMessageBus,
    private agentIds: string[]
  ) {}

  async requestConsensus(
    proposal: string,
    options: {
      requiredMajority?: number;  // 0.5-1.0 (default 0.67 = 2/3)
      timeoutMs?: number;
    } = {}
  ): Promise<{ approved: boolean; votes: Vote[]; reasoning: string }> {
    const { requiredMajority = 0.67, timeoutMs = 30000 } = options;
    const requestId = crypto.randomUUID();

    const votes: Vote[] = [];
    const votePromise = new Promise<Vote[]>((resolve) => {
      const timeout = setTimeout(() => resolve(votes), timeoutMs);

      const unsubscribe = this.bus.subscribe("consensus-coordinator", async (message) => {
        if (
          message.type === "consensus_vote" &&
          (message.payload as { requestId: string }).requestId === requestId
        ) {
          votes.push(message.payload as Vote);

          if (votes.length === this.agentIds.length) {
            clearTimeout(timeout);
            unsubscribe();
            resolve(votes);
          }
        }
      });
    });

    // Request votes from all agents
    await Promise.all(
      this.agentIds.map((agentId) =>
        this.bus.publish({
          id: crypto.randomUUID(),
          type: "consensus_vote",
          senderId: "consensus-coordinator",
          recipientId: agentId,
          correlationId: requestId,
          payload: { id: requestId, proposal, requiredVotes: this.agentIds.length } as ConsensusRequest,
          priority: "high",
          timestamp: new Date(),
          ttl: timeoutMs,
        })
      )
    );

    const receivedVotes = await votePromise;
    
    const approvals = receivedVotes.filter((v) => v.vote === "approve").length;
    const majority = approvals / this.agentIds.length;
    const approved = majority >= requiredMajority;

    const reasoning = await this.synthesizeDecision(proposal, receivedVotes, approved);

    return { approved, votes: receivedVotes, reasoning };
  }

  private async synthesizeDecision(
    proposal: string,
    votes: Vote[],
    approved: boolean
  ): Promise<string> {
    const votesSummary = votes
      .map((v) => `- ${v.agentId}: ${v.vote} — ${v.reasoning}`)
      .join("\n");

    return `Decision: ${approved ? "APPROVED" : "REJECTED"}\n\nVotes:\n${votesSummary}`;
  }
}

interface Vote {
  requestId: string;
  agentId: string;
  vote: "approve" | "reject";
  reasoning: string;
}

// Complete Multi-Agent System
async function createMultiAgentSystem(llm: BaseAgent["llm"]) {
  const bus = new AgentMessageBus();
  
  const researchAgent = new ResearchAgent(bus, llm);
  const codingAgent = new CodingAgent(bus, llm);
  const reviewAgent = new ReviewAgent(bus, llm);

  const agentRegistry = new Map([
    [researchAgent["id"], { specialization: "web research and information gathering", id: researchAgent["id"] }],
    [codingAgent["id"], { specialization: "software development and code generation", id: codingAgent["id"] }],
    [reviewAgent["id"], { specialization: "quality assurance and code review", id: reviewAgent["id"] }],
  ]);

  const orchestrator = new OrchestratorAgent(bus, llm, [researchAgent, codingAgent, reviewAgent], agentRegistry);
  const consensus = new ConsensusCoordinator(bus, [researchAgent["id"], codingAgent["id"], reviewAgent["id"]]);

  // Start all agents
  [researchAgent, codingAgent, reviewAgent, orchestrator].forEach((a) => a.start());

  return { orchestrator, consensus, bus, agents: { researchAgent, codingAgent, reviewAgent } };
}
```

---

## Tóm tắt Bài 18

| Pattern | Agents | Coordination | Use Case |
|---------|--------|-------------|---------|
| Hierarchical | Orchestrator + Workers | Top-down assignment | Complex decomposable tasks |
| Peer-to-peer | Equals | Message passing | Collaborative research |
| Consensus | Voters | Majority vote | Critical decisions |
| Specialist Teams | Domain experts | Role-based routing | Enterprise workflows |

## Bài tập thực hành

1. Implement **Dynamic Agent Spawning**: orchestrator tạo temporary specialist agents khi cần và terminate sau khi xong.
2. Xây dựng **Agent Load Balancer**: distribute tasks đến agents dựa trên current workload và specialization score.
3. Implement **Fault-Tolerant Consensus**: Byzantine fault tolerant voting, tolerate f faulty agents với 3f+1 total agents.

---

*Tiếp theo: [Bài 19 — Testing AI Systems](19-testing-ai-systems.md)*

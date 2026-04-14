/**
 * Bài 18: Multi-Agent Orchestration
 * ====================================
 * Chạy: npm run lesson18
 *
 * Nội dung:
 *  - Supervisor / Hierarchical agent delegation
 *  - Specialized sub-agents (Researcher, Coder, Reviewer)
 *  - Message-passing protocol between agents
 *  - Consensus / voting (BFT-style)
 *  - Agent graph topology
 */

import { EventEmitter } from "eventemitter3";

// ─────────────────────────────────────────────────────────────────────────────
// 1. AGENT MESSAGE PROTOCOL
// ─────────────────────────────────────────────────────────────────────────────

type AgentId = string;

type AgentMessage =
  | { type: "task";     from: AgentId; to: AgentId; taskId: string; content: string; priority: number }
  | { type: "result";   from: AgentId; to: AgentId; taskId: string; content: string; success: boolean }
  | { type: "delegate"; from: AgentId; to: AgentId; taskId: string; subtask: string; agentType: string }
  | { type: "vote";     from: AgentId; to: AgentId; taskId: string; proposal: string; vote: "accept" | "reject"; reason: string }
  | { type: "broadcast"; from: AgentId; content: string };

// ─────────────────────────────────────────────────────────────────────────────
// 2. BASE AGENT CLASS
// ─────────────────────────────────────────────────────────────────────────────

interface AgentCapability {
  type: string;
  description: string;
}

interface AgentEvents {
  message: [msg: AgentMessage];
  taskComplete: [taskId: string, result: string];
  taskFailed: [taskId: string, error: Error];
}

abstract class BaseAgent extends EventEmitter<AgentEvents> {
  protected inbox: AgentMessage[] = [];
  protected taskHistory: Map<string, { status: "pending" | "done" | "failed"; result?: string }> = new Map();

  constructor(
    readonly id: AgentId,
    readonly capabilities: AgentCapability[],
  ) { super(); }

  receive(msg: AgentMessage): void {
    this.inbox.push(msg);
    this.emit("message", msg);
  }

  abstract process(msg: AgentMessage): Promise<AgentMessage | null>;

  async processAll(): Promise<void> {
    const msgs = [...this.inbox];
    this.inbox = [];
    for (const msg of msgs) {
      const response = await this.process(msg);
      if (response) this.emit("message", response);
    }
  }

  getTaskResult(taskId: string): { status: "pending" | "done" | "failed"; result?: string } | undefined {
    return this.taskHistory.get(taskId);
  }

  canHandle(taskType: string): boolean {
    return this.capabilities.some(c => c.type === taskType);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. SPECIALIZED AGENTS
// ─────────────────────────────────────────────────────────────────────────────

class ResearcherAgent extends BaseAgent {
  constructor(id: AgentId) {
    super(id, [{ type: "research", description: "Searches and retrieves information" }]);
  }

  async process(msg: AgentMessage): Promise<AgentMessage | null> {
    if (msg.type !== "task" && msg.type !== "delegate") return null;

    const content = msg.type === "task" ? msg.content : msg.subtask;
    console.log(`    [${this.id}] Researching: "${content.slice(0, 50)}"`);
    await new Promise(r => setTimeout(r, 20));

    const result = `Research findings on "${content.slice(0, 30)}": Found 5 relevant sources. Key facts: [1] TypeScript enables type safety. [2] CRDTs allow conflict-free sync.`;
    const taskId = msg.taskId;
    this.taskHistory.set(taskId, { status: "done", result });

    return { type: "result", from: this.id, to: msg.from, taskId, content: result, success: true };
  }
}

class CoderAgent extends BaseAgent {
  constructor(id: AgentId) {
    super(id, [{ type: "code", description: "Writes and reviews TypeScript code" }]);
  }

  async process(msg: AgentMessage): Promise<AgentMessage | null> {
    if (msg.type !== "task" && msg.type !== "delegate") return null;

    const content = msg.type === "task" ? msg.content : msg.subtask;
    console.log(`    [${this.id}] Coding: "${content.slice(0, 50)}"`);
    await new Promise(r => setTimeout(r, 30));

    const code = `// TypeScript implementation\nfunction solve(): void {\n  console.log("Solving: ${content.slice(0, 30)}");\n}`;
    const taskId = msg.taskId;
    this.taskHistory.set(taskId, { status: "done", result: code });

    return { type: "result", from: this.id, to: msg.from, taskId, content: code, success: true };
  }
}

class ReviewerAgent extends BaseAgent {
  constructor(id: AgentId) {
    super(id, [{ type: "review", description: "Reviews code and content for quality" }]);
  }

  async process(msg: AgentMessage): Promise<AgentMessage | null> {
    if (msg.type !== "task" && msg.type !== "delegate") return null;

    const content = msg.type === "task" ? msg.content : msg.subtask;
    console.log(`    [${this.id}] Reviewing: "${content.slice(0, 50)}"`);
    await new Promise(r => setTimeout(r, 15));

    const passed = !content.toLowerCase().includes("bad") && content.length > 10;
    const review = passed
      ? "✅ Code review passed. Type safety: OK. Logic: OK. Edge cases: handled."
      : "❌ Review failed. Issues found: missing type annotations, no error handling.";

    const taskId = msg.taskId;
    this.taskHistory.set(taskId, { status: passed ? "done" : "failed", result: review });

    return { type: "result", from: this.id, to: msg.from, taskId, content: review, success: passed };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. SUPERVISOR AGENT (hierarchical orchestration)
// ─────────────────────────────────────────────────────────────────────────────

interface WorkflowStep {
  id:        string;
  agentType: "research" | "code" | "review";
  task:      string;
  dependsOn: string[];
  result?:   string;
  status:    "pending" | "running" | "done" | "failed";
}

class SupervisorAgent extends BaseAgent {
  private subAgents = new Map<string, BaseAgent>();
  private workflows = new Map<string, WorkflowStep[]>();

  constructor(id: AgentId) {
    super(id, [{ type: "supervise", description: "Orchestrates sub-agents" }]);
  }

  registerAgent(agentType: string, agent: BaseAgent): void {
    this.subAgents.set(agentType, agent);
    // Forward agent messages back to supervisor
    agent.on("message", async (msg) => {
      if (msg.type === "result") await this.handleResult(msg);
    });
  }

  async execute(workflowId: string, steps: WorkflowStep[]): Promise<Map<string, string>> {
    this.workflows.set(workflowId, steps);
    const results = new Map<string, string>();

    console.log(`  [Supervisor] Starting workflow: ${workflowId} (${steps.length} steps)`);

    // Topological execution
    const completed = new Set<string>();

    while (completed.size < steps.length) {
      const ready = steps.filter(step =>
        step.status === "pending" &&
        step.dependsOn.every(d => completed.has(d)),
      );

      if (ready.length === 0) break; // deadlock or done

      // Run ready steps concurrently
      await Promise.all(ready.map(async step => {
        step.status = "running";
        console.log(`  [Supervisor] → Delegating step "${step.id}" to ${step.agentType}-agent`);

        const agent = this.subAgents.get(step.agentType);
        if (!agent) { step.status = "failed"; return; }

        const taskMsg: AgentMessage = {
          type:     "delegate",
          from:     this.id,
          to:       agent.id,
          taskId:   `${workflowId}:${step.id}`,
          subtask:  step.task,
          agentType: step.agentType,
        };

        agent.receive(taskMsg);
        await agent.processAll();

        // Result was forwarded via event
        const result = agent.getTaskResult(`${workflowId}:${step.id}`);
        if (result?.result !== undefined) step.result = result.result;
        step.status = result?.status === "done" ? "done" : "failed";
        if (step.result) results.set(step.id, step.result);
        completed.add(step.id);
      }));
    }

    return results;
  }

  private async handleResult(msg: AgentMessage & { type: "result" }): Promise<void> {
    // Optional: aggregate results, notify caller, etc.
  }

  async process(msg: AgentMessage): Promise<AgentMessage | null> { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. CONSENSUS / VOTING (BFT-style)
// ─────────────────────────────────────────────────────────────────────────────

interface VoteRecord {
  agentId: AgentId;
  vote:    "accept" | "reject";
  reason:  string;
  timestamp: number;
}

class ConsensusOrchestrator {
  private votes = new Map<string, VoteRecord[]>();

  async collectVotes(
    proposal: string,
    voters: BaseAgent[],
    quorum: number, // minimum accepts needed
  ): Promise<{ accepted: boolean; votes: VoteRecord[]; proposal: string }> {
    const taskId = `vote_${Date.now()}`;
    this.votes.set(taskId, []);

    console.log(`  [Consensus] Proposal: "${proposal.slice(0, 60)}" | Voters: ${voters.length} | Quorum: ${quorum}`);

    // Simulate each voter
    const results = await Promise.all(voters.map(async (agent, i) => {
      await new Promise(r => setTimeout(r, 10 * (i + 1)));
      // Deterministic mock: even-indexed accept, odd-indexed reject
      const vote: "accept" | "reject" = i % 2 === 0 ? "accept" : "reject";
      const record: VoteRecord = {
        agentId:   agent.id,
        vote,
        reason:    vote === "accept" ? "Proposal meets quality criteria" : "Insufficient evidence",
        timestamp: Date.now(),
      };
      this.votes.get(taskId)!.push(record);
      console.log(`    [${agent.id}] Voted: ${vote} — ${record.reason}`);
      return record;
    }));

    const accepts   = results.filter(v => v.vote === "accept").length;
    const accepted  = accepts >= quorum;

    console.log(`  [Consensus] Result: ${accepts}/${voters.length} accepted — ${accepted ? "✅ ACCEPTED" : "❌ REJECTED"}`);
    return { accepted, votes: results, proposal };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. AGENT GRAPH
// ─────────────────────────────────────────────────────────────────────────────

interface AgentNode {
  agent: BaseAgent;
  connections: AgentId[];
  role: "supervisor" | "worker" | "validator";
}

class AgentGraph {
  private nodes = new Map<AgentId, AgentNode>();

  addNode(agent: BaseAgent, role: AgentNode["role"], connections: AgentId[] = []): void {
    this.nodes.set(agent.id, { agent, connections, role });
  }

  route(from: AgentId, to: AgentId, msg: AgentMessage): boolean {
    const node = this.nodes.get(from);
    if (!node || !node.connections.includes(to)) {
      console.log(`  [Graph] ⛔ No route from ${from} to ${to}`);
      return false;
    }
    const targetNode = this.nodes.get(to);
    targetNode?.agent.receive(msg);
    return true;
  }

  topology(): string {
    const lines: string[] = [];
    for (const [id, node] of this.nodes) {
      const conns = node.connections.join(", ") || "none";
      lines.push(`  ${id} (${node.role}) → [${conns}]`);
    }
    return lines.join("\n");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DEMO / RUN
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n══════════════════════════════════════");
  console.log(" Bài 18: Multi-Agent Orchestration");
  console.log("══════════════════════════════════════\n");

  // Create agents
  const supervisor = new SupervisorAgent("supervisor");
  const researcher = new ResearcherAgent("researcher-1");
  const coder      = new CoderAgent("coder-1");
  const reviewer   = new ReviewerAgent("reviewer-1");

  supervisor.registerAgent("research", researcher);
  supervisor.registerAgent("code",     coder);
  supervisor.registerAgent("review",   reviewer);

  // ── Hierarchical Workflow ──
  console.log("[Hierarchical Workflow — Supervisor Pattern]");
  const steps: WorkflowStep[] = [
    { id: "research", agentType: "research", task: "Find best practices for TypeScript AI agents", dependsOn: [], status: "pending" },
    { id: "code",     agentType: "code",     task: "Implement a type-safe agent loop in TypeScript", dependsOn: ["research"], status: "pending" },
    { id: "review",   agentType: "review",   task: "Review the implemented code for quality and safety", dependsOn: ["code"], status: "pending" },
  ];

  const results = await supervisor.execute("ai-agent-workflow", steps);
  console.log("\n  Workflow results:");
  for (const [step, result] of results) {
    console.log(`    [${step}]: ${result.slice(0, 80)}...`);
  }

  // ── Consensus Voting ──
  console.log("\n[Consensus Voting (BFT-style)]");
  const consensus = new ConsensusOrchestrator();
  const voters = [researcher, coder, reviewer,
    new ResearcherAgent("researcher-2"),
    new CoderAgent("coder-2"),
  ];
  const { accepted, votes } = await consensus.collectVotes(
    "Adopt TypeScript strict mode as the project standard",
    voters,
    3, // need 3/5 to accept
  );
  console.log(`  Decision: ${accepted ? "Adopted" : "Rejected"} (${votes.filter(v => v.vote === "accept").length}/${votes.length} votes)`);

  // ── Agent Graph ──
  console.log("\n[Agent Graph Topology]");
  const graph = new AgentGraph();
  graph.addNode(supervisor, "supervisor", ["researcher-1", "coder-1", "reviewer-1"]);
  graph.addNode(researcher, "worker",    ["supervisor"]);
  graph.addNode(coder,      "worker",    ["supervisor", "reviewer-1"]);
  graph.addNode(reviewer,   "validator", ["supervisor"]);
  console.log(graph.topology());

  // Route a message through the graph
  const routed = graph.route("supervisor", "researcher-1", {
    type: "task", from: "supervisor", to: "researcher-1",
    taskId: "direct_task", content: "Research gRPC streaming patterns", priority: 1,
  });
  console.log(`  Message routed: ${routed}`);

  // Invalid route
  const invalid = graph.route("researcher-1", "coder-1", {
    type: "task", from: "researcher-1", to: "coder-1",
    taskId: "invalid", content: "Bypass supervisor", priority: 0,
  });
  console.log(`  Invalid route blocked: ${!invalid}`);

  console.log("\n✅ Bài 18 hoàn thành!\n");
}

main().catch(console.error);

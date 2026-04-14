/**
 * Bài 19: Testing AI Systems in TypeScript
 * ==========================================
 * Chạy: npm run lesson19
 *
 * Nội dung:
 *  - Mock LLM client with deterministic responses
 *  - LLM-as-judge evaluation
 *  - Property-based tests (fast-check simulation)
 *  - Golden dataset / regression testing
 *  - CRDT property invariant tests
 *  - Evals: F1 score, ROUGE-1, exact match
 */

// ─────────────────────────────────────────────────────────────────────────────
// 1. MOCK LLM CLIENT (deterministic for tests)
// ─────────────────────────────────────────────────────────────────────────────

interface LLMCall {
  prompt: string;
  model: string;
  temperature: number;
  response: string;
}

class MockLLMClient {
  private callLog:  LLMCall[] = [];
  private fixtures: Map<string, string> = new Map();
  private defaultResponse = "Mock response for testing";

  /** Pre-program responses by prompt substring match */
  when(promptSubstring: string, response: string): this {
    this.fixtures.set(promptSubstring, response);
    return this;
  }

  async complete(prompt: string, model = "gpt-4o", temperature = 0): Promise<string> {
    // Match fixture (longest key wins)
    const matched = [...this.fixtures.entries()]
      .filter(([k]) => prompt.includes(k))
      .sort((a, b) => b[0].length - a[0].length)[0];

    const response = matched ? matched[1] : this.defaultResponse;
    this.callLog.push({ prompt, model, temperature, response });
    return response;
  }

  get calls():    LLMCall[] { return [...this.callLog]; }
  get callCount(): number    { return this.callLog.length; }
  reset(): void              { this.callLog = []; }

  /** Assert: was called exactly N times */
  assertCallCount(n: number): void {
    if (this.callCount !== n) throw new Error(`Expected ${n} LLM calls, got ${this.callCount}`);
  }

  /** Assert: was called with a prompt containing the given substring */
  assertCalledWith(substring: string): void {
    const found = this.callLog.some(c => c.prompt.includes(substring));
    if (!found) throw new Error(`LLM was never called with prompt containing: "${substring}"`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. LLM-AS-JUDGE EVALUATION
// ─────────────────────────────────────────────────────────────────────────────

interface EvalCriteria {
  name: string;
  prompt: string;
  minScore: number; // 0–10
}

interface EvalResult {
  criteria: string;
  score: number;
  passed: boolean;
  reasoning: string;
}

interface JudgeResult {
  question:    string;
  answer:      string;
  results:     EvalResult[];
  avgScore:    number;
  passed:      boolean;
}

const DEFAULT_CRITERIA: EvalCriteria[] = [
  { name: "correctness",   prompt: "Is the answer factually correct? Rate 0-10.", minScore: 7 },
  { name: "helpfulness",   prompt: "Is the answer helpful and complete? Rate 0-10.", minScore: 6 },
  { name: "conciseness",   prompt: "Is the answer concise without unnecessary padding? Rate 0-10.", minScore: 5 },
];

async function llmAsJudge(
  question: string,
  answer: string,
  criteria: EvalCriteria[],
  judge: MockLLMClient,
): Promise<JudgeResult> {
  const results: EvalResult[] = [];

  for (const criterion of criteria) {
    const prompt = [
      `Question: ${question}`,
      `Answer: ${answer}`,
      "",
      `Evaluation: ${criterion.prompt}`,
      "Respond with JSON: { score: number, reasoning: string }",
    ].join("\n");

    const raw = await judge.complete(prompt, "gpt-4o", 0);
    // Extract mock score from fixture
    let score = 8, reasoning = "Meets requirements";
    try {
      const parsed = JSON.parse(raw) as { score: number; reasoning: string };
      score     = parsed.score;
      reasoning = parsed.reasoning;
    } catch { /* use defaults */ }

    results.push({ criteria: criterion.name, score, passed: score >= criterion.minScore, reasoning });
  }

  const avgScore = results.reduce((s, r) => s + r.score, 0) / results.length;
  return { question, answer, results, avgScore, passed: results.every(r => r.passed) };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. METRICS: ROUGE-1, EXACT MATCH, F1
// ─────────────────────────────────────────────────────────────────────────────

function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^\w\s]/g, "").split(/\s+/).filter(Boolean);
}

function rougeN(reference: string, hypothesis: string, n = 1): number {
  const refNgrams  = getNgrams(tokenize(reference), n);
  const hypNgrams  = getNgrams(tokenize(hypothesis), n);
  if (refNgrams.length === 0) return 0;
  let overlap = 0;
  const hypSet = new Map<string, number>();
  for (const ng of hypNgrams) hypSet.set(ng, (hypSet.get(ng) ?? 0) + 1);
  for (const ng of refNgrams) {
    const c = hypSet.get(ng) ?? 0;
    if (c > 0) { overlap++; hypSet.set(ng, c - 1); }
  }
  const precision = overlap / hypNgrams.length || 0;
  const recall    = overlap / refNgrams.length;
  if (precision + recall === 0) return 0;
  return 2 * precision * recall / (precision + recall); // F1
}

function getNgrams(tokens: string[], n: number): string[] {
  const ngrams: string[] = [];
  for (let i = 0; i <= tokens.length - n; i++) {
    ngrams.push(tokens.slice(i, i + n).join(" "));
  }
  return ngrams;
}

function exactMatch(reference: string, hypothesis: string): boolean {
  return reference.trim().toLowerCase() === hypothesis.trim().toLowerCase();
}

function tokenF1(reference: string, hypothesis: string): number {
  const refTokens = new Set(tokenize(reference));
  const hypTokens = new Set(tokenize(hypothesis));
  const intersection = [...refTokens].filter(t => hypTokens.has(t));
  if (intersection.length === 0) return 0;
  const precision = intersection.length / hypTokens.size;
  const recall    = intersection.length / refTokens.size;
  return 2 * precision * recall / (precision + recall);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. GOLDEN DATASET / REGRESSION TESTS
// ─────────────────────────────────────────────────────────────────────────────

interface GoldenExample {
  id:        string;
  input:     string;
  expected:  string;
  tolerance: number; // ROUGE-1 minimum
}

interface RegressionResult {
  exampleId: string;
  actual:    string;
  expected:  string;
  rouge1:    number;
  f1:        number;
  em:        boolean;
  passed:    boolean;
}

async function runRegressionSuite(
  dataset: GoldenExample[],
  generate: (input: string) => Promise<string>,
): Promise<RegressionResult[]> {
  const results: RegressionResult[] = [];
  for (const example of dataset) {
    const actual = await generate(example.input);
    const rouge1 = rougeN(example.expected, actual, 1);
    const f1     = tokenF1(example.expected, actual);
    const em     = exactMatch(example.expected, actual);
    results.push({
      exampleId: example.id,
      actual,
      expected:  example.expected,
      rouge1,
      f1,
      em,
      passed:    rouge1 >= example.tolerance,
    });
  }
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. PROPERTY-BASED TESTING (fast-check simulation)
// ─────────────────────────────────────────────────────────────────────────────

// Minimal property-based framework
interface PropertyTest<T> {
  name: string;
  generate: () => T;
  property: (value: T) => boolean;
  runs?: number;
}

function runProperty<T>(test: PropertyTest<T>): { passed: boolean; failedOn?: T; runs: number } {
  const runs = test.runs ?? 100;
  for (let i = 0; i < runs; i++) {
    const value = test.generate();
    if (!test.property(value)) {
      return { passed: false, failedOn: value, runs: i + 1 };
    }
  }
  return { passed: true, runs };
}

// CRDT invariants as properties

class GCounter {
  private counts = new Map<string, number>();
  constructor(readonly nodeId: string) {}
  increment(by = 1): void { this.counts.set(this.nodeId, (this.counts.get(this.nodeId) ?? 0) + by); }
  value(): number { return [...this.counts.values()].reduce((a, b) => a + b, 0); }
  merge(other: GCounter): void {
    for (const [node, count] of other.counts) {
      this.counts.set(node, Math.max(this.counts.get(node) ?? 0, count));
    }
  }
  clone(): GCounter {
    const c = new GCounter(this.nodeId);
    for (const [k, v] of this.counts) c.counts.set(k, v);
    return c;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DEMO / RUN
// ─────────────────────────────────────────────────────────────────────────────

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  console.log(`  ✅ ${message}`);
}

async function main() {
  console.log("\n══════════════════════════════════════");
  console.log(" Bài 19: Testing AI Systems");
  console.log("══════════════════════════════════════\n");

  // ── Mock LLM Client ──
  console.log("[Mock LLM Client]");
  const mockLLM = new MockLLMClient()
    .when("TypeScript", "TypeScript is a statically typed superset of JavaScript.")
    .when("CRDTs",      "CRDTs are conflict-free replicated data types.")
    .when("offline",    "Offline-first means the app works without network connectivity.");

  const r1 = await mockLLM.complete("Explain TypeScript generics");
  const r2 = await mockLLM.complete("How do CRDTs work?");
  const r3 = await mockLLM.complete("Unknown topic query");

  assert(r1.includes("TypeScript"), "TypeScript fixture matched");
  assert(r2.includes("conflict-free"), "CRDTs fixture matched");
  assert(r3 === "Mock response for testing", "Default response for unknown");
  assert(mockLLM.callCount === 3, "Exactly 3 LLM calls");
  mockLLM.assertCalledWith("TypeScript generics");

  // ── LLM-as-Judge ──
  console.log("\n[LLM-as-Judge Evaluation]");
  const judge = new MockLLMClient()
    .when("correctness",  JSON.stringify({ score: 9, reasoning: "Factually accurate" }))
    .when("helpfulness",  JSON.stringify({ score: 8, reasoning: "Well explained" }))
    .when("conciseness",  JSON.stringify({ score: 7, reasoning: "Appropriately concise" }));

  const judgeResult = await llmAsJudge(
    "What is TypeScript?",
    "TypeScript is a statically typed superset of JavaScript that compiles to plain JS.",
    DEFAULT_CRITERIA,
    judge,
  );
  console.log(`  Average score: ${judgeResult.avgScore.toFixed(1)} | Passed: ${judgeResult.passed}`);
  judgeResult.results.forEach(r =>
    console.log(`    ${r.criteria.padEnd(15)} score=${r.score} passed=${r.passed} — ${r.reasoning}`),
  );

  // ── Metrics ──
  console.log("\n[Evaluation Metrics]");
  const ref = "TypeScript is a statically typed programming language";
  const hyp = "TypeScript provides static typing for JavaScript programs";
  console.log(`  Reference: "${ref}"`);
  console.log(`  Hypothesis: "${hyp}"`);
  console.log(`  ROUGE-1 F1: ${rougeN(ref, hyp).toFixed(4)}`);
  console.log(`  Token F1:   ${tokenF1(ref, hyp).toFixed(4)}`);
  console.log(`  Exact Match: ${exactMatch(ref, hyp)}`);

  const perfectRef = "TypeScript is great";
  console.log(`\n  Perfect match ROUGE-1: ${rougeN(perfectRef, perfectRef).toFixed(4)} (expect 1.0)`);

  // ── Golden Dataset ──
  console.log("\n[Golden Dataset Regression Tests]");
  const dataset: GoldenExample[] = [
    { id: "ts-01", input: "What is TypeScript?", expected: "TypeScript is a statically typed superset of JavaScript.", tolerance: 0.4 },
    { id: "crdt-01", input: "How do CRDTs work?", expected: "CRDTs are conflict-free replicated data types.", tolerance: 0.4 },
    { id: "offline-01", input: "What is offline-first?", expected: "Offline-first means the app works without network.", tolerance: 0.3 },
  ];

  const mockGen = new MockLLMClient()
    .when("TypeScript",   "TypeScript is a statically typed superset of JavaScript.")
    .when("CRDTs",        "CRDTs allow conflict-free replicated data types.")
    .when("offline",      "Offline-first means the app works without network connectivity.");

  const regressionResults = await runRegressionSuite(
    dataset,
    input => mockGen.complete(input),
  );

  regressionResults.forEach(r => {
    const status = r.passed ? "✅" : "❌";
    console.log(`  ${status} ${r.exampleId} ROUGE=${r.rouge1.toFixed(3)} F1=${r.f1.toFixed(3)} EM=${r.em} passed=${r.passed}`);
  });

  const passRate = regressionResults.filter(r => r.passed).length / regressionResults.length;
  console.log(`  Pass rate: ${(passRate * 100).toFixed(0)}%`);

  // ── Property-Based Tests: CRDT Invariants ──
  console.log("\n[Property-Based Tests — CRDT Invariants]");

  // P1: G-Counter is monotonically increasing
  const p1 = runProperty<number>({
    name: "GCounter monotonicity",
    generate: () => Math.floor(Math.random() * 100),
    property: (n) => {
      const gc = new GCounter("nodeA");
      const before = gc.value();
      gc.increment(n);
      return gc.value() >= before;
    },
  });
  console.log(`  P1 Monotonicity: passed=${p1.passed} (${p1.runs} runs)`);

  // P2: Merge is commutative (A merge B == B merge A)
  const p2 = runProperty<[number, number]>({
    name: "GCounter merge commutativity",
    generate: () => [Math.floor(Math.random() * 50), Math.floor(Math.random() * 50)] as [number, number],
    property: ([a, b]) => {
      const gcA = new GCounter("nodeA");
      const gcB = new GCounter("nodeB");
      gcA.increment(a);
      gcB.increment(b);

      const mergedAB = gcA.clone(); mergedAB.merge(gcB);
      const mergedBA = gcB.clone(); mergedBA.merge(gcA);
      return mergedAB.value() === mergedBA.value();
    },
    runs: 50,
  });
  console.log(`  P2 Commutativity: passed=${p2.passed} (${p2.runs} runs)`);

  // P3: Merge is idempotent (A merge A == A)
  const p3 = runProperty<number>({
    name: "GCounter merge idempotency",
    generate: () => Math.floor(Math.random() * 100),
    property: (n) => {
      const gc = new GCounter("nodeA");
      gc.increment(n);
      const before = gc.value();
      gc.merge(gc.clone()); // idempotent merge
      return gc.value() === before;
    },
    runs: 50,
  });
  console.log(`  P3 Idempotency: passed=${p3.passed} (${p3.runs} runs)`);

  console.log("\n✅ Bài 19 hoàn thành!\n");
}

main().catch(console.error);

export {};

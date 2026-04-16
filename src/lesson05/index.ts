/**
 * Bài 5: Service Workers & Background Sync (Node simulation)
 * ===========================================================
 * Chạy: npm run lesson05
 *
 * Nội dung:
 *  - Typed cache manifest & cache manager
 *  - Fetch strategy simulation (cache-first, network-first, stale-while-revalidate)
 *  - LLM response caching with hash keys
 *  - Offline request queue with retry (mirrors Background Sync API)
 *  - Push notification schema (discriminated union)
 *  - Service Worker registration manager (client-side simulation)
 *  - Workbox-style precache + runtime caching strategies
 */

import { EventEmitter } from "eventemitter3";
import * as crypto from "crypto";

// ─────────────────────────────────────────────────────────────────────────────
// 1. TYPED CACHE MANIFEST
// ─────────────────────────────────────────────────────────────────────────────

type CacheName = "precache" | "runtime-api" | "runtime-images" | "runtime-fonts";

interface CacheManifest {
  cacheName: CacheName;
  version: string;
  assets: string[];
  maxEntries?: number;
  maxAgeSeconds?: number;
}

const CACHE_MANIFESTS: readonly CacheManifest[] = [
  { cacheName: "precache",        version: "1.0.0", assets: ["/", "/index.html", "/app.js", "/app.css"] },
  { cacheName: "runtime-api",     version: "1.0.0", assets: [], maxEntries: 50,   maxAgeSeconds: 60 * 60 },
  { cacheName: "runtime-images",  version: "1.0.0", assets: [], maxEntries: 100,  maxAgeSeconds: 60 * 60 * 24 * 7 },
  { cacheName: "runtime-fonts",   version: "1.0.0", assets: [], maxEntries: 10,   maxAgeSeconds: 60 * 60 * 24 * 365 },
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// 2. CACHE MANAGER (in-memory simulation of Cache API)
// ─────────────────────────────────────────────────────────────────────────────

interface CachedResponse {
  url: string;
  body: string;
  headers: Record<string, string>;
  cachedAt: number;
  maxAgeSeconds: number;
}

class CacheManager {
  private caches = new Map<CacheName, Map<string, CachedResponse>>();

  private getOrCreate(name: CacheName): Map<string, CachedResponse> {
    if (!this.caches.has(name)) this.caches.set(name, new Map());
    return this.caches.get(name)!;
  }

  put(cacheName: CacheName, url: string, body: string, headers: Record<string, string> = {}, maxAgeSeconds = 3600): void {
    const cache = this.getOrCreate(cacheName);
    cache.set(url, { url, body, headers, cachedAt: Date.now(), maxAgeSeconds });
  }

  match(url: string): CachedResponse | null {
    for (const cache of this.caches.values()) {
      const entry = cache.get(url);
      if (!entry) continue;
      const age = (Date.now() - entry.cachedAt) / 1000;
      if (age > entry.maxAgeSeconds) { cache.delete(url); continue; }
      return entry;
    }
    return null;
  }

  matchInCache(cacheName: CacheName, url: string): CachedResponse | null {
    const cache = this.caches.get(cacheName);
    if (!cache) return null;
    const entry = cache.get(url);
    if (!entry) return null;
    const age = (Date.now() - entry.cachedAt) / 1000;
    if (age > entry.maxAgeSeconds) { cache.delete(url); return null; }
    return entry;
  }

  delete(cacheName: CacheName, url: string): boolean {
    return this.caches.get(cacheName)?.delete(url) ?? false;
  }

  prune(): number {
    let removed = 0;
    for (const cache of this.caches.values()) {
      for (const [url, entry] of cache) {
        if ((Date.now() - entry.cachedAt) / 1000 > entry.maxAgeSeconds) {
          cache.delete(url); removed++;
        }
      }
    }
    return removed;
  }

  stats(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [name, cache] of this.caches) result[name] = cache.size;
    return result;
  }

  clearCache(cacheName: CacheName): void {
    this.caches.get(cacheName)?.clear();
  }

  listCacheNames(): CacheName[] {
    return [...this.caches.keys()];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. FETCH STRATEGY SIMULATION
// ─────────────────────────────────────────────────────────────────────────────

type FetchResult = { body: string; source: "cache" | "network" };

// Simulates network fetch — can be configured to fail
function simulateNetworkFetch(url: string, shouldFail = false): FetchResult | null {
  if (shouldFail) return null;
  return { body: `[network] response for ${url}`, source: "network" };
}

function cacheFirst(url: string, cacheName: CacheName, cm: CacheManager, networkDown = false): FetchResult | null {
  const cached = cm.matchInCache(cacheName, url);
  if (cached) return { body: cached.body, source: "cache" };
  const netResult = simulateNetworkFetch(url, networkDown);
  if (netResult) {
    cm.put(cacheName, url, netResult.body, {}, 86400);
  }
  return netResult;
}

function networkFirst(url: string, cacheName: CacheName, cm: CacheManager, networkDown = false): FetchResult | null {
  const netResult = simulateNetworkFetch(url, networkDown);
  if (netResult) {
    cm.put(cacheName, url, netResult.body, {}, 60);
    return netResult;
  }
  const cached = cm.matchInCache(cacheName, url);
  if (cached) return { body: cached.body, source: "cache" };
  return null;
}

function staleWhileRevalidate(url: string, cacheName: CacheName, cm: CacheManager, networkDown = false): FetchResult {
  const cached = cm.matchInCache(cacheName, url);
  // Background revalidation
  const netResult = simulateNetworkFetch(url, networkDown);
  if (netResult) {
    cm.put(cacheName, url, netResult.body, {}, 3600);
  }
  if (cached) return { body: cached.body, source: "cache" };
  return netResult ?? { body: "[offline] unavailable", source: "network" };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. LLM RESPONSE CACHE (hash-based keying)
// ─────────────────────────────────────────────────────────────────────────────

function hashString(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 16);
}

interface LLMRequest {
  model: string;
  prompt: string;
  temperature: number;
}

class LLMCacheStrategy {
  constructor(private cm: CacheManager, private cacheName: CacheName = "runtime-api") {}

  lookup(request: LLMRequest): { body: string; cacheHit: boolean } | null {
    const key = this.buildKey(request);
    const cached = this.cm.matchInCache(this.cacheName, key);
    if (cached) return { body: cached.body, cacheHit: true };
    return null;
  }

  store(request: LLMRequest, responseBody: string): void {
    const key = this.buildKey(request);
    this.cm.put(this.cacheName, key, responseBody, { "X-Cache": "STORED" }, 3600);
  }

  fetchWithCache(request: LLMRequest, networkDown = false): { body: string; cacheHit: boolean } {
    const cached = this.lookup(request);
    if (cached) return cached;
    if (networkDown) {
      return { body: JSON.stringify({ error: "offline", queued: true }), cacheHit: false };
    }
    const body = JSON.stringify({ response: `LLM response for: ${request.prompt}`, model: request.model });
    this.store(request, body);
    return { body, cacheHit: false };
  }

  private buildKey(req: LLMRequest): string {
    return `llm:${hashString(JSON.stringify({ model: req.model, prompt: req.prompt, temperature: req.temperature }))}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. BACKGROUND SYNC QUEUE
// ─────────────────────────────────────────────────────────────────────────────

interface SyncRequest {
  id: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  body?: string;
  headers?: Record<string, string>;
  attempts: number;
  maxAttempts: number;
  createdAt: number;
  tag: string;
}

interface SyncQueueEvents {
  enqueued:  [request: SyncRequest];
  replayed:  [request: SyncRequest, response: string];
  failed:    [request: SyncRequest, error: Error];
  exhausted: [request: SyncRequest];
}

class BackgroundSyncQueue extends EventEmitter<SyncQueueEvents> {
  private queue: SyncRequest[] = [];

  enqueue(req: Omit<SyncRequest, "id" | "attempts" | "createdAt" | "maxAttempts">, maxAttempts = 3): string {
    const id = `sync_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const sr: SyncRequest = { ...req, id, attempts: 0, maxAttempts, createdAt: Date.now() };
    this.queue.push(sr);
    this.emit("enqueued", sr);
    return id;
  }

  async replayAll(fetcher: (req: SyncRequest) => Promise<string>): Promise<void> {
    const toProcess = [...this.queue];
    for (const req of toProcess) {
      try {
        const response = await fetcher(req);
        this.queue = this.queue.filter(r => r.id !== req.id);
        this.emit("replayed", req, response);
      } catch (err) {
        req.attempts++;
        if (req.attempts >= req.maxAttempts) {
          this.queue = this.queue.filter(r => r.id !== req.id);
          this.emit("exhausted", req);
        } else {
          this.emit("failed", req, err instanceof Error ? err : new Error(String(err)));
        }
      }
    }
  }

  get size(): number { return this.queue.length; }

  getQueue(): readonly SyncRequest[] { return this.queue; }
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. PUSH NOTIFICATION SCHEMA
// ─────────────────────────────────────────────────────────────────────────────

type PushPayload =
  | { type: "message";     from: string; preview: string; threadId: string }
  | { type: "sync_needed"; collection: string; since: number }
  | { type: "invalidate";  keys: string[] }
  | { type: "alert";       severity: "info" | "warning" | "error"; message: string };

function handlePushPayload(payload: PushPayload): void {
  switch (payload.type) {
    case "message":
      console.log(`  📨 New message from ${payload.from}: "${payload.preview}"`);
      break;
    case "sync_needed":
      console.log(`  🔄 Sync needed for "${payload.collection}" since ${new Date(payload.since).toISOString()}`);
      break;
    case "invalidate":
      console.log(`  🗑️  Cache invalidate: [${payload.keys.join(", ")}]`);
      break;
    case "alert":
      console.log(`  🚨 [${payload.severity.toUpperCase()}] ${payload.message}`);
      break;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. SERVICE WORKER MANAGER (client-side simulation)
// ─────────────────────────────────────────────────────────────────────────────

type SWMessageType = "SYNC_COMPLETE" | "CACHE_UPDATED" | "OFFLINE_STATUS";

interface SWMessage {
  type: SWMessageType;
  url?: string;
  data?: unknown;
}

class ServiceWorkerManager {
  private registered = false;
  private swPath: string | null = null;
  private messageHandlers = new Map<SWMessageType, Set<(data: SWMessage) => void>>();

  async register(swPath: string): Promise<void> {
    this.swPath = swPath;
    this.registered = true;
    console.log(`  [SWManager] Registered: ${swPath}`);
  }

  isRegistered(): boolean { return this.registered; }

  on(type: SWMessageType, handler: (data: SWMessage) => void): () => void {
    if (!this.messageHandlers.has(type)) {
      this.messageHandlers.set(type, new Set());
    }
    this.messageHandlers.get(type)!.add(handler);
    return () => { this.messageHandlers.get(type)?.delete(handler); };
  }

  simulateMessage(message: SWMessage): void {
    const handlers = this.messageHandlers.get(message.type);
    if (handlers) {
      for (const handler of handlers) handler(message);
    }
  }

  async requestSync(tag: string): Promise<void> {
    if (!this.registered) throw new Error("SW not registered");
    console.log(`  [SWManager] Background sync requested: ${tag}`);
  }

  async skipWaiting(): Promise<void> {
    console.log("  [SWManager] Skip waiting — new SW activated");
  }

  getSwPath(): string | null { return this.swPath; }
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. WORKBOX-STYLE ROUTING
// ─────────────────────────────────────────────────────────────────────────────

type RouteStrategy = "cache-first" | "network-first" | "stale-while-revalidate" | "network-only";

interface RouteDefinition {
  pattern: RegExp;
  strategy: RouteStrategy;
  cacheName: CacheName;
  maxAgeSeconds?: number;
}

const ROUTES: RouteDefinition[] = [
  { pattern: /\/api\//,          strategy: "network-first",          cacheName: "runtime-api",    maxAgeSeconds: 60 },
  { pattern: /\.(png|jpg|svg)$/, strategy: "cache-first",            cacheName: "runtime-images", maxAgeSeconds: 604800 },
  { pattern: /\.(woff2?)$/,      strategy: "cache-first",            cacheName: "runtime-fonts",  maxAgeSeconds: 31536000 },
  { pattern: /.*/,               strategy: "stale-while-revalidate", cacheName: "precache",       maxAgeSeconds: 86400 },
];

function matchRoute(url: string): RouteDefinition {
  const route = ROUTES.find(r => r.pattern.test(url));
  return route ?? ROUTES[ROUTES.length - 1]!;
}

function executeStrategy(url: string, route: RouteDefinition, cm: CacheManager, networkDown = false): FetchResult | null {
  switch (route.strategy) {
    case "cache-first":
      return cacheFirst(url, route.cacheName, cm, networkDown);
    case "network-first":
      return networkFirst(url, route.cacheName, cm, networkDown);
    case "stale-while-revalidate":
      return staleWhileRevalidate(url, route.cacheName, cm, networkDown);
    case "network-only":
      return simulateNetworkFetch(url, networkDown);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DEMO / RUN
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n══════════════════════════════════════");
  console.log(" Bài 5: Service Workers & Background Sync");
  console.log("══════════════════════════════════════\n");

  // ── Cache Manager ──
  console.log("[1. Cache Manager]");
  const cacheManager = new CacheManager();

  CACHE_MANIFESTS[0]!.assets.forEach(url => {
    cacheManager.put("precache", url, `<html>...${url}</html>`, {}, 86400);
  });
  cacheManager.put("runtime-api", "/api/notes", JSON.stringify([{ id: 1, title: "Note" }]), { "content-type": "application/json" }, 60);

  console.log("  Cache stats:", cacheManager.stats());
  console.log("  Match /api/notes:", cacheManager.match("/api/notes")?.body.slice(0, 40));
  console.log("  Match /index.html:", cacheManager.match("/index.html") ? "HIT" : "MISS");
  console.log("  Match /unknown:", cacheManager.match("/unknown") ? "HIT" : "MISS");
  console.log("  Cache names:", cacheManager.listCacheNames().join(", "));

  // ── Fetch Strategies ──
  console.log("\n[2. Fetch Strategies]");
  const cm2 = new CacheManager();
  cm2.put("precache", "/page.html", "<html>cached page</html>", {}, 86400);

  const r1 = cacheFirst("/page.html", "precache", cm2);
  console.log(`  cache-first /page.html → source=${r1?.source}, body="${r1?.body.slice(0, 30)}"`);

  const r2 = networkFirst("/api/data", "runtime-api", cm2);
  console.log(`  network-first /api/data → source=${r2?.source}`);

  const r3 = networkFirst("/api/data", "runtime-api", cm2, true);
  console.log(`  network-first /api/data (offline) → source=${r3?.source} (fallback to cache)`);

  const r4 = staleWhileRevalidate("/page.html", "precache", cm2);
  console.log(`  stale-while-revalidate /page.html → source=${r4.source}`);

  // ── LLM Cache ──
  console.log("\n[3. LLM Response Cache]");
  const llmCache = new LLMCacheStrategy(cacheManager);
  const llmReq: LLMRequest = { model: "gpt-4", prompt: "Explain TypeScript generics", temperature: 0.7 };

  const res1 = llmCache.fetchWithCache(llmReq);
  console.log(`  First call: cacheHit=${res1.cacheHit}`);

  const res2 = llmCache.fetchWithCache(llmReq);
  console.log(`  Second call (same prompt): cacheHit=${res2.cacheHit}`);

  const res3 = llmCache.fetchWithCache({ ...llmReq, prompt: "Different prompt" });
  console.log(`  Different prompt: cacheHit=${res3.cacheHit}`);

  const res4 = llmCache.fetchWithCache(llmReq, true);
  console.log(`  Same prompt offline: cacheHit=${res4.cacheHit}`);

  // ── Background Sync Queue ──
  console.log("\n[4. Background Sync Queue]");
  const syncQueue = new BackgroundSyncQueue();
  syncQueue.on("enqueued", req  => console.log(`  ✚ Enqueued [${req.tag}] ${req.method} ${req.url}`));
  syncQueue.on("replayed", req  => console.log(`  ✅ Replayed ${req.method} ${req.url}`));
  syncQueue.on("failed",   req  => console.log(`  ❌ Failed ${req.method} ${req.url} (attempt ${req.attempts}/${req.maxAttempts})`));
  syncQueue.on("exhausted",req  => console.log(`  🗑️  Exhausted ${req.method} ${req.url}`));

  syncQueue.enqueue({ method: "POST", url: "/api/notes", body: JSON.stringify({ title: "Offline note" }), tag: "notes-sync" });
  syncQueue.enqueue({ method: "PUT",  url: "/api/notes/1", body: JSON.stringify({ title: "Updated" }), tag: "notes-sync" });
  syncQueue.enqueue({ method: "DELETE", url: "/api/notes/99", tag: "notes-sync" }, 2);

  let call = 0;
  await syncQueue.replayAll(async (req) => {
    call++;
    if (call === 3) throw new Error("404 Not Found");
    return `{ "ok": true, "url": "${req.url}" }`;
  });
  await syncQueue.replayAll(async () => { throw new Error("Still failing"); });
  console.log(`  Queue size after replay: ${syncQueue.size}`);

  // ── Push Notifications ──
  console.log("\n[5. Push Notifications]");
  const pushMessages: PushPayload[] = [
    { type: "message",     from: "Alice", preview: "Can we sync?", threadId: "t_1" },
    { type: "sync_needed", collection: "notes", since: Date.now() - 60_000 },
    { type: "invalidate",  keys: ["/api/notes", "/api/tags"] },
    { type: "alert",       severity: "warning", message: "Rate limit approaching" },
  ];
  pushMessages.forEach(handlePushPayload);

  // ── Service Worker Manager ──
  console.log("\n[6. Service Worker Manager]");
  const swManager = new ServiceWorkerManager();
  await swManager.register("/sw.js");
  console.log(`  Registered: ${swManager.isRegistered()}, path: ${swManager.getSwPath()}`);

  const unsub = swManager.on("SYNC_COMPLETE", (msg) => {
    console.log(`  📡 Received SYNC_COMPLETE for ${msg.url}`);
  });
  swManager.on("CACHE_UPDATED", () => {
    console.log("  📡 Received CACHE_UPDATED — new SW version available");
  });

  swManager.simulateMessage({ type: "SYNC_COMPLETE", url: "/api/notes" });
  swManager.simulateMessage({ type: "CACHE_UPDATED" });
  unsub(); // unsubscribe
  swManager.simulateMessage({ type: "SYNC_COMPLETE", url: "/api/notes" }); // no handler

  await swManager.requestSync("ai-sync");
  await swManager.skipWaiting();

  // ── Route Matching & Execution ──
  console.log("\n[7. Workbox-style Routing]");
  const testUrls = ["/api/users/1", "/images/logo.png", "/fonts/inter.woff2", "/dashboard"];
  testUrls.forEach(url => {
    const route = matchRoute(url);
    console.log(`  ${url.padEnd(25)} → strategy=${route.strategy.padEnd(25)} cache=${route.cacheName}`);
  });

  console.log("\n  Executing strategies with CacheManager:");
  const cm3 = new CacheManager();
  for (const url of testUrls) {
    const route = matchRoute(url);
    const result = executeStrategy(url, route, cm3);
    console.log(`  ${url.padEnd(25)} → ${result?.source ?? "unavailable"}`);
  }

  console.log("\n✅ Bài 5 hoàn thành!\n");
}

main().catch(console.error);

export {}

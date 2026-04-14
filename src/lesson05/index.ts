/**
 * Bài 5: Service Workers & Background Sync (Node simulation)
 * ===========================================================
 * Chạy: npm run lesson05
 *
 * Nội dung:
 *  - Typed cache manifest & cache manager
 *  - Offline request queue with retry (mirrors Background Sync API)
 *  - Push notification schema
 *  - Workbox-style precache + runtime caching strategies
 */

import { EventEmitter } from "eventemitter3";

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
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. BACKGROUND SYNC QUEUE
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
  tag: string; // Background Sync tag
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

  /** Simulate replaying stored requests when online */
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
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. PUSH NOTIFICATION SCHEMA
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
// 5. WORKBOX-STYLE ROUTING
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

// ─────────────────────────────────────────────────────────────────────────────
// DEMO / RUN
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n══════════════════════════════════════");
  console.log(" Bài 5: Service Workers & Background Sync");
  console.log("══════════════════════════════════════\n");

  // ── Cache Manager ──
  console.log("[Cache Manager]");
  const cacheManager = new CacheManager();

  // Precache app shell
  CACHE_MANIFESTS[0]!.assets.forEach(url => {
    cacheManager.put("precache", url, `<html>...${url}</html>`, {}, 86400);
  });
  cacheManager.put("runtime-api", "/api/notes", JSON.stringify([{ id: 1, title: "Note" }]), { "content-type": "application/json" }, 60);

  console.log("  Cache stats:", cacheManager.stats());
  console.log("  Match /api/notes:", cacheManager.match("/api/notes")?.body.slice(0, 40));
  console.log("  Match /index.html:", cacheManager.match("/index.html") ? "HIT" : "MISS");
  console.log("  Match /unknown:", cacheManager.match("/unknown") ? "HIT" : "MISS");

  // ── Background Sync Queue ──
  console.log("\n[Background Sync Queue]");
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
  console.log("\n[Push Notifications]");
  const pushMessages: PushPayload[] = [
    { type: "message",     from: "Alice", preview: "Can we sync?", threadId: "t_1" },
    { type: "sync_needed", collection: "notes", since: Date.now() - 60_000 },
    { type: "invalidate",  keys: ["/api/notes", "/api/tags"] },
    { type: "alert",       severity: "warning", message: "Rate limit approaching" },
  ];
  pushMessages.forEach(handlePushPayload);

  // ── Route Matching ──
  console.log("\n[Workbox-style Routing]");
  const testUrls = ["/api/users/1", "/images/logo.png", "/fonts/inter.woff2", "/dashboard"];
  testUrls.forEach(url => {
    const route = matchRoute(url);
    console.log(`  ${url.padEnd(25)} → strategy=${route.strategy.padEnd(25)} cache=${route.cacheName}`);
  });

  console.log("\n✅ Bài 5 hoàn thành!\n");
}

main().catch(console.error);

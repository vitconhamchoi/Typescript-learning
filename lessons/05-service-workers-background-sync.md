# Bài 5: Service Workers & Background Sync

## Mục tiêu bài học

- Implement Service Worker với TypeScript đầy đủ
- Xây dựng offline caching strategy cho AI responses
- Background Sync API cho reliable offline operations
- Push Notifications cho AI task completion

---

## 5.1 TypeScript Service Worker Setup

```typescript
// sw.ts — Service Worker với TypeScript
/// <reference lib="webworker" />

declare const self: ServiceWorkerGlobalScope;

const CACHE_VERSION = "v3";
const CACHES = {
  static: `static-${CACHE_VERSION}`,
  api: `api-${CACHE_VERSION}`,
  llm: `llm-${CACHE_VERSION}`,
};

const STATIC_ASSETS = [
  "/",
  "/index.html",
  "/app.js",
  "/app.css",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

const API_PATTERNS = {
  llmComplete: /\/api\/v1\/llm\/complete/,
  embeddings: /\/api\/v1\/embeddings/,
  userProfile: /\/api\/v1\/user\/profile/,
};

// ============ LIFECYCLE EVENTS ============

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const staticCache = await caches.open(CACHES.static);
      await staticCache.addAll(STATIC_ASSETS);
      
      // Skip waiting to activate immediately
      await self.skipWaiting();
      console.log("[SW] Installed and static assets cached");
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Clean up old caches
      const cacheNames = await caches.keys();
      const validCaches = Object.values(CACHES);
      
      await Promise.all(
        cacheNames
          .filter((name) => !validCaches.includes(name))
          .map((name) => caches.delete(name))
      );
      
      // Take control of all clients immediately
      await self.clients.claim();
      console.log("[SW] Activated, old caches cleaned");
    })()
  );
});

// ============ FETCH STRATEGIES ============

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  
  // Skip non-GET and cross-origin for most strategies
  if (event.request.method !== "GET" && !isSyncRequest(event.request)) {
    event.respondWith(networkWithOfflineQueue(event.request));
    return;
  }
  
  // LLM API: Cache-first with network fallback (expensive to compute)
  if (API_PATTERNS.llmComplete.test(url.pathname)) {
    event.respondWith(llmCacheStrategy(event.request));
    return;
  }
  
  // Embeddings: Cache-only (embeddings don't change for same text)
  if (API_PATTERNS.embeddings.test(url.pathname)) {
    event.respondWith(embeddingsCacheStrategy(event.request));
    return;
  }
  
  // User profile: Stale-while-revalidate
  if (API_PATTERNS.userProfile.test(url.pathname)) {
    event.respondWith(staleWhileRevalidate(event.request, CACHES.api));
    return;
  }
  
  // Static assets: Cache-first
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(event.request, CACHES.static));
    return;
  }
});

// ============ STRATEGY IMPLEMENTATIONS ============

async function cacheFirst(request: Request, cacheName: string): Promise<Response> {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  
  const response = await fetch(request);
  if (response.ok) {
    await cache.put(request, response.clone());
  }
  return response;
}

async function staleWhileRevalidate(request: Request, cacheName: string): Promise<Response> {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  
  // Revalidate in background
  const networkPromise = fetch(request).then(async (response) => {
    if (response.ok) {
      await cache.put(request, response.clone());
    }
    return response;
  });
  
  return cached ?? networkPromise;
}

async function llmCacheStrategy(request: Request): Promise<Response> {
  // LLM responses are cached by request body hash
  const body = await request.clone().text();
  const cacheKey = await hashString(body);
  
  const cache = await caches.open(CACHES.llm);
  const cached = await cache.match(new Request(cacheKey));
  
  if (cached) {
    // Add cache header to indicate it's from cache
    const headers = new Headers(cached.headers);
    headers.set("X-Cache", "HIT");
    return new Response(cached.body, { headers, status: cached.status });
  }
  
  try {
    const response = await fetch(request);
    if (response.ok) {
      // Cache for 1 hour (LLM responses are deterministic for same prompt+temp)
      const responseToCache = response.clone();
      const headers = new Headers(responseToCache.headers);
      headers.set("Cache-Control", "max-age=3600");
      headers.set("X-Cache", "MISS");
      await cache.put(new Request(cacheKey), new Response(await responseToCache.blob(), { headers }));
    }
    return response;
  } catch {
    // Return offline response
    return offlineLLMResponse();
  }
}

async function embeddingsCacheStrategy(request: Request): Promise<Response> {
  const body = await request.clone().text();
  const cacheKey = await hashString(body);
  
  const cache = await caches.open(CACHES.llm);
  const cached = await cache.match(new Request(cacheKey));
  if (cached) return cached;
  
  const response = await fetch(request);
  if (response.ok) {
    // Embeddings are permanent (same text = same embedding)
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "immutable, max-age=31536000");
    await cache.put(new Request(cacheKey), response.clone());
  }
  return response;
}

async function networkWithOfflineQueue(request: Request): Promise<Response> {
  try {
    return await fetch(request);
  } catch {
    // Queue for background sync
    await queueFailedRequest(request);
    return new Response(
      JSON.stringify({ queued: true, message: "Request queued for sync" }),
      { status: 202, headers: { "Content-Type": "application/json" } }
    );
  }
}

function isSyncRequest(request: Request): boolean {
  return request.headers.get("X-Sync-Request") === "true";
}

function offlineLLMResponse(): Response {
  return new Response(
    JSON.stringify({
      error: "offline",
      message: "You are currently offline. Your request has been queued.",
      queued: true,
    }),
    {
      status: 503,
      headers: {
        "Content-Type": "application/json",
        "X-Offline": "true",
      },
    }
  );
}

// ============ BACKGROUND SYNC ============

const SYNC_TAG = "ai-sync";
const PUSH_TAG = "ai-task-complete";

self.addEventListener("sync", (event) => {
  if (event.tag === SYNC_TAG) {
    event.waitUntil(processSyncQueue());
  }
});

interface QueuedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  timestamp: number;
  retryCount: number;
}

async function queueFailedRequest(request: Request): Promise<void> {
  const db = await openSyncDB();
  const queued: QueuedRequest = {
    url: request.url,
    method: request.method,
    headers: Object.fromEntries(request.headers.entries()),
    body: request.method !== "GET" ? await request.text() : null,
    timestamp: Date.now(),
    retryCount: 0,
  };
  
  const tx = db.transaction("queue", "readwrite");
  await tx.store.add(queued);
  
  // Register background sync
  await self.registration.sync.register(SYNC_TAG);
}

async function processSyncQueue(): Promise<void> {
  const db = await openSyncDB();
  const tx = db.transaction("queue", "readwrite");
  const requests = await tx.store.getAll();
  
  console.log(`[SW] Processing ${requests.length} queued requests`);
  
  for (const queued of requests) {
    try {
      const response = await fetch(queued.url, {
        method: queued.method,
        headers: { ...queued.headers, "X-Sync-Request": "true" },
        body: queued.body,
      });
      
      if (response.ok) {
        await tx.store.delete(queued.timestamp);
        console.log(`[SW] Synced request: ${queued.url}`);
        
        // Notify clients of successful sync
        await notifyClients({
          type: "SYNC_COMPLETE",
          url: queued.url,
        });
      } else if (response.status >= 400 && response.status < 500) {
        // Client error: don't retry
        await tx.store.delete(queued.timestamp);
        console.warn(`[SW] Client error, dropping request: ${queued.url}`);
      }
    } catch (error) {
      console.error(`[SW] Failed to sync request:`, error);
      // Will retry on next sync event
    }
  }
}

async function notifyClients(data: unknown): Promise<void> {
  const clients = await self.clients.matchAll({ type: "window" });
  clients.forEach((client) => client.postMessage(data));
}

// Simple IDB wrapper for sync queue
async function openSyncDB(): Promise<{ transaction: (store: string, mode: IDBTransactionMode) => { store: { add: (item: unknown) => Promise<unknown>; getAll: () => Promise<QueuedRequest[]>; delete: (key: unknown) => Promise<void> } } }> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("sw-sync-db", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("queue", { keyPath: "timestamp" });
    };
    request.onsuccess = () => resolve(wrapIDB(request.result));
    request.onerror = () => reject(request.error);
  });
}

function wrapIDB(db: IDBDatabase) {
  return {
    transaction: (store: string, mode: IDBTransactionMode) => {
      const tx = db.transaction(store, mode);
      const objectStore = tx.objectStore(store);
      return {
        store: {
          add: (item: unknown) => idbRequest(objectStore.add(item)),
          getAll: () => idbRequest(objectStore.getAll()) as Promise<QueuedRequest[]>,
          delete: (key: unknown) => idbRequest(objectStore.delete(key as IDBValidKey)),
        },
      };
    },
  };
}

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// ============ PUSH NOTIFICATIONS ============

self.addEventListener("push", (event) => {
  if (!event.data) return;
  
  const data = event.data.json() as PushPayload;
  
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/icons/icon-192.png",
      badge: "/icons/badge.png",
      data: data.actionUrl,
      actions: [
        { action: "view", title: "View Result" },
        { action: "dismiss", title: "Dismiss" },
      ],
      tag: PUSH_TAG,
      renotify: true,
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  
  if (event.action === "view") {
    const url = event.notification.data as string;
    event.waitUntil(
      self.clients.openWindow(url)
    );
  }
});

interface PushPayload {
  title: string;
  body: string;
  actionUrl: string;
}

// ============ UTILITIES ============

async function hashString(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}
```

---

## 5.2 Service Worker Registration (Client-side)

```typescript
// sw-registration.ts — Client-side SW management
interface SWMessage {
  type: "SYNC_COMPLETE" | "CACHE_UPDATED" | "OFFLINE_STATUS";
  url?: string;
  data?: unknown;
}

class ServiceWorkerManager {
  private registration: ServiceWorkerRegistration | null = null;
  private messageHandlers = new Map<string, Set<(data: SWMessage) => void>>();

  async register(swPath: string): Promise<void> {
    if (!("serviceWorker" in navigator)) {
      console.warn("Service Workers not supported");
      return;
    }

    try {
      this.registration = await navigator.serviceWorker.register(swPath, {
        scope: "/",
        updateViaCache: "none", // Always check for updates
      });

      // Listen for updates
      this.registration.addEventListener("updatefound", () => {
        const newWorker = this.registration!.installing;
        newWorker?.addEventListener("statechange", () => {
          if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
            this.emit("CACHE_UPDATED", {});
          }
        });
      });

      // Listen for messages from SW
      navigator.serviceWorker.addEventListener("message", (event) => {
        const message = event.data as SWMessage;
        this.emit(message.type, message);
      });

      console.log("Service Worker registered");
    } catch (error) {
      console.error("SW registration failed:", error);
    }
  }

  on(type: SWMessage["type"], handler: (data: SWMessage) => void): () => void {
    if (!this.messageHandlers.has(type)) {
      this.messageHandlers.set(type, new Set());
    }
    this.messageHandlers.get(type)!.add(handler);
    return () => this.messageHandlers.get(type)?.delete(handler);
  }

  private emit(type: string, data: unknown): void {
    this.messageHandlers.get(type)?.forEach((handler) =>
      handler({ type: type as SWMessage["type"], ...data as object })
    );
  }

  async requestSync(): Promise<void> {
    if (!this.registration) return;
    try {
      await this.registration.sync.register("ai-sync");
      console.log("Background sync requested");
    } catch (error) {
      console.warn("Background sync not available:", error);
    }
  }

  async subscribeToPush(vapidPublicKey: string): Promise<PushSubscription | null> {
    if (!this.registration) return null;
    
    try {
      const subscription = await this.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: this.urlBase64ToUint8Array(vapidPublicKey),
      });
      return subscription;
    } catch (error) {
      console.error("Push subscription failed:", error);
      return null;
    }
  }

  async skipWaiting(): Promise<void> {
    const waiting = this.registration?.waiting;
    if (waiting) {
      waiting.postMessage({ type: "SKIP_WAITING" });
    }
  }

  private urlBase64ToUint8Array(base64String: string): Uint8Array {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const rawData = atob(base64);
    return new Uint8Array([...rawData].map((char) => char.charCodeAt(0)));
  }
}

// React hook for offline status
function useOfflineStatus(swManager: ServiceWorkerManager) {
  let isOnline = navigator.onLine;
  let pendingCount = 0;

  // In real React app:
  // const [isOnline, setIsOnline] = useState(navigator.onLine);
  // const [pendingCount, setPendingCount] = useState(0);
  
  // useEffect(() => {
  //   const handleOnline = () => setIsOnline(true);
  //   const handleOffline = () => setIsOnline(false);
  //   window.addEventListener("online", handleOnline);
  //   window.addEventListener("offline", handleOffline);
  //   const unsub = swManager.on("SYNC_COMPLETE", () => {
  //     setPendingCount(c => Math.max(0, c - 1));
  //   });
  //   return () => {
  //     window.removeEventListener("online", handleOnline);
  //     window.removeEventListener("offline", handleOffline);
  //     unsub();
  //   };
  // }, [swManager]);

  return { isOnline, pendingCount };
}
```

---

## 5.3 Workbox Integration (Production-ready)

```typescript
// sw-workbox.ts — Production SW với Workbox
/// <reference lib="webworker" />
import { precacheAndRoute, cleanupOutdatedCaches } from "workbox-precaching";
import { registerRoute } from "workbox-routing";
import { CacheFirst, NetworkFirst, StaleWhileRevalidate } from "workbox-strategies";
import { ExpirationPlugin } from "workbox-expiration";
import { BackgroundSyncPlugin } from "workbox-background-sync";
import { CacheableResponsePlugin } from "workbox-cacheable-response";

declare const self: ServiceWorkerGlobalScope;

// Precache static assets (injected by Workbox CLI/webpack plugin)
precacheAndRoute(self.__WB_MANIFEST ?? []);
cleanupOutdatedCaches();

// LLM API: Network-first, 24h cache
registerRoute(
  ({ url }) => url.pathname.startsWith("/api/v1/llm"),
  new NetworkFirst({
    cacheName: "llm-api-cache",
    networkTimeoutSeconds: 30,
    plugins: [
      new CacheableResponsePlugin({ statuses: [200] }),
      new ExpirationPlugin({
        maxEntries: 200,
        maxAgeSeconds: 24 * 60 * 60, // 24 hours
      }),
    ],
  })
);

// Embeddings: Cache-first, permanent
registerRoute(
  ({ url }) => url.pathname.startsWith("/api/v1/embeddings"),
  new CacheFirst({
    cacheName: "embeddings-cache",
    plugins: [
      new CacheableResponsePlugin({ statuses: [200] }),
      new ExpirationPlugin({
        maxEntries: 1000,
        maxAgeSeconds: 365 * 24 * 60 * 60, // 1 year
      }),
    ],
  })
);

// Background sync for failed API mutations
const bgSyncPlugin = new BackgroundSyncPlugin("ai-sync-queue", {
  maxRetentionTime: 24 * 60, // 24 hours in minutes
  onSync: async ({ queue }) => {
    let entry;
    while ((entry = await queue.shiftRequest())) {
      try {
        await fetch(entry.request);
        console.log("[Workbox] Replayed request:", entry.request.url);
      } catch (error) {
        console.error("[Workbox] Replay failed:", error);
        await queue.unshiftRequest(entry);
        throw error;
      }
    }
  },
});

// Register mutation routes with background sync
registerRoute(
  ({ url, request }) =>
    url.pathname.startsWith("/api/v1/") && request.method !== "GET",
  new NetworkFirst({
    plugins: [bgSyncPlugin],
  }),
  "POST"
);

registerRoute(
  ({ url, request }) =>
    url.pathname.startsWith("/api/v1/") && request.method !== "GET",
  new NetworkFirst({
    plugins: [bgSyncPlugin],
  }),
  "PUT"
);

registerRoute(
  ({ url, request }) =>
    url.pathname.startsWith("/api/v1/") && request.method !== "GET",
  new NetworkFirst({
    plugins: [bgSyncPlugin],
  }),
  "DELETE"
);

// User profile: Stale-while-revalidate
registerRoute(
  ({ url }) => url.pathname.startsWith("/api/v1/user"),
  new StaleWhileRevalidate({
    cacheName: "user-data-cache",
    plugins: [
      new ExpirationPlugin({ maxEntries: 10, maxAgeSeconds: 3600 }),
    ],
  })
);
```

---

## Tóm tắt Bài 5

| Feature | API | TypeScript Pattern |
|---------|-----|--------------------|
| Static Caching | Cache API | Async/await, event listeners |
| LLM Response Cache | Cache API + SHA-256 | Request hashing |
| Background Sync | Sync API | IDB queue |
| Push Notifications | Push API | Event handlers |
| Production SW | Workbox | Plugin pattern |

## Bài tập thực hành

1. Implement **Periodic Background Sync** (`periodicSync`) để sync AI conversation history mỗi 15 phút khi app không mở.
2. Thêm **Cache Storage quota management**: tự động xóa entries cũ nhất khi storage > 80% quota.
3. Implement **Smart Prefetching**: khi user đang đọc một conversation, prefetch related conversations.

---

*Tiếp theo: [Bài 6 — Distributed Systems Fundamentals](06-distributed-systems-fundamentals.md)*

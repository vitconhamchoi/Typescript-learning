# Bài 5: Service Workers & Background Sync

## Mục tiêu bài học

- Implement Service Worker với TypeScript đầy đủ
- Xây dựng offline caching strategy cho AI responses
- Background Sync API cho reliable offline operations
- Push Notifications cho AI task completion

---

## 5.1 TypeScript Service Worker Setup

Service Worker lifecycle gồm 3 giai đoạn: **install**, **activate**, và **fetch**. Mỗi event dùng `event.waitUntil()` để giữ SW alive.

```typescript
// Cache manifest — typed config cho mỗi cache bucket
type CacheName = "precache" | "runtime-api" | "runtime-images";

interface CacheManifest {
  cacheName: CacheName;
  version: string;
  assets: string[];
  maxEntries?: number;
  maxAgeSeconds?: number;
}
```

Lifecycle events đăng ký qua `self.addEventListener`:

```typescript
// Install: precache static assets
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open("static-v1").then((cache) => cache.addAll(STATIC_ASSETS))
  );
});

// Activate: clean old caches
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((names) =>
    Promise.all(names.filter((n) => !validCaches.includes(n)).map((n) => caches.delete(n)))
  ));
});
```

---

## 5.2 Fetch Strategies (Caching Patterns)

Mỗi loại resource cần strategy khác nhau:

| Strategy | Use Case |
|----------|----------|
| Cache-first | Static assets, fonts |
| Network-first | API calls |
| Stale-while-revalidate | User profile |
| Cache with hash key | LLM responses |

```typescript
// Cache-first: return cached, fallback to network
async function cacheFirst(request: Request, cacheName: string): Promise<Response> {
  const cached = await caches.open(cacheName).then((c) => c.match(request));
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await caches.open(cacheName).then((c) => c.put(request, response.clone()));
  return response;
}
```

```typescript
// Stale-while-revalidate: return cache immediately, update in background
async function staleWhileRevalidate(request: Request, cacheName: string): Promise<Response> {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const networkPromise = fetch(request).then(async (res) => {
    if (res.ok) await cache.put(request, res.clone());
    return res;
  });
  return cached ?? networkPromise;
}
```

---

## 5.3 Background Sync Queue

Khi offline, requests được queue vào IndexedDB. Khi online lại, SW replays chúng qua Background Sync API.

```typescript
interface SyncRequest {
  id: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  url: string;
  body?: string;
  attempts: number;
  maxAttempts: number;
  tag: string;
}
```

```typescript
// Enqueue failed request & register sync
async function queueFailedRequest(request: Request): Promise<void> {
  const queued = { url: request.url, method: request.method, body: await request.text() };
  await db.transaction("queue", "readwrite").store.add(queued);
  await self.registration.sync.register("ai-sync");
}
```

---

## 5.4 Push Notifications

Push payload là discriminated union — mỗi type có data riêng:

```typescript
type PushPayload =
  | { type: "message";     from: string; preview: string }
  | { type: "sync_needed"; collection: string }
  | { type: "invalidate";  keys: string[] }
  | { type: "alert";       severity: "info" | "warning" | "error"; message: string };
```

```typescript
// Handle push event — show notification
self.addEventListener("push", (event) => {
  const data = event.data!.json() as PushPayload;
  event.waitUntil(
    self.registration.showNotification(data.title, { body: data.body })
  );
});
```

---

## 5.5 Service Worker Registration (Client-side)

Client-side code đăng ký SW, listen cho updates, và giao tiếp qua `postMessage`:

```typescript
class ServiceWorkerManager {
  private registration: ServiceWorkerRegistration | null = null;

  async register(swPath: string): Promise<void> {
    this.registration = await navigator.serviceWorker.register(swPath, {
      scope: "/", updateViaCache: "none",
    });
  }

  async requestSync(): Promise<void> {
    await this.registration?.sync.register("ai-sync");
  }
}
```

---

## 5.6 Workbox Integration (Production-ready)

Workbox đơn giản hóa SW development bằng pre-built strategies và plugins:

```typescript
// Workbox-style route definition
type RouteStrategy = "cache-first" | "network-first" | "stale-while-revalidate";

interface RouteDefinition {
  pattern: RegExp;
  strategy: RouteStrategy;
  cacheName: string;
  maxAgeSeconds?: number;
}
```

```typescript
// Match URL to strategy — first matching route wins
const ROUTES: RouteDefinition[] = [
  { pattern: /\/api\//, strategy: "network-first", cacheName: "runtime-api" },
  { pattern: /\.(png|jpg)$/, strategy: "cache-first", cacheName: "runtime-images" },
  { pattern: /.*/, strategy: "stale-while-revalidate", cacheName: "precache" },
];
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

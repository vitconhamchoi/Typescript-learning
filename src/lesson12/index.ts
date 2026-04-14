/**
 * Bài 12: Cross-Platform Mobile with React Native (Adapter Pattern)
 * ==================================================================
 * Chạy: npm run lesson12
 *
 * Nội dung:
 *  - Platform-agnostic storage interface
 *  - Web (InMemory) + Mobile (MMKV/SQLite) adapters
 *  - Shared business logic (~75% code share)
 *  - React Navigation type-safe route params
 *  - Offline sync adapter for mobile
 */

// ─────────────────────────────────────────────────────────────────────────────
// 1. PLATFORM-AGNOSTIC INTERFACES
// ─────────────────────────────────────────────────────────────────────────────

interface StorageAdapter {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
  clear(): Promise<void>;
}

interface DatabaseAdapter<T extends { id: string }> {
  find(id: string): Promise<T | null>;
  findAll(filter?: Partial<T>): Promise<T[]>;
  save(entity: T): Promise<T>;
  delete(id: string): Promise<void>;
  count(): Promise<number>;
}

interface NetworkAdapter {
  get<T>(url: string, headers?: Record<string, string>): Promise<T>;
  post<T>(url: string, body: unknown, headers?: Record<string, string>): Promise<T>;
  put<T>(url: string, body: unknown, headers?: Record<string, string>): Promise<T>;
  delete(url: string, headers?: Record<string, string>): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. WEB ADAPTER (InMemory — mirrors localStorage / IndexedDB API)
// ─────────────────────────────────────────────────────────────────────────────

class InMemoryStorageAdapter implements StorageAdapter {
  private store = new Map<string, string>();

  async get<T>(key: string): Promise<T | null> {
    const raw = this.store.get(key);
    return raw ? JSON.parse(raw) as T : null;
  }
  async set<T>(key: string, value: T): Promise<void> { this.store.set(key, JSON.stringify(value)); }
  async delete(key: string): Promise<void> { this.store.delete(key); }
  async keys(): Promise<string[]> { return [...this.store.keys()]; }
  async clear(): Promise<void> { this.store.clear(); }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. MOBILE ADAPTER (simulates MMKV — synchronous but typed)
// ─────────────────────────────────────────────────────────────────────────────

class MMKVStorageAdapter implements StorageAdapter {
  /** MMKV in production is synchronous but we wrap in Promise to match interface */
  private storage = new Map<string, string>();

  async get<T>(key: string): Promise<T | null> {
    const raw = this.storage.get(key);
    return raw ? JSON.parse(raw) as T : null;
  }
  async set<T>(key: string, value: T): Promise<void> {
    this.storage.set(key, JSON.stringify(value));
    console.log(`    [MMKV] SET ${key}`);
  }
  async delete(key: string): Promise<void> { this.storage.delete(key); }
  async keys(): Promise<string[]> { return [...this.storage.keys()]; }
  async clear(): Promise<void> { this.storage.clear(); }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. SHARED BUSINESS LOGIC (platform-agnostic)
// ─────────────────────────────────────────────────────────────────────────────

interface UserPreferences {
  theme: "light" | "dark" | "system";
  language: string;
  notificationsEnabled: boolean;
  aiProvider: "openai" | "anthropic" | "gemini";
  offlineMode: boolean;
}

const DEFAULT_PREFS: UserPreferences = {
  theme: "system",
  language: "en",
  notificationsEnabled: true,
  aiProvider: "openai",
  offlineMode: false,
};

class UserPreferencesService {
  private readonly PREFS_KEY = "user:preferences";

  constructor(private readonly storage: StorageAdapter) {}

  async get(): Promise<UserPreferences> {
    const stored = await this.storage.get<UserPreferences>(this.PREFS_KEY);
    return { ...DEFAULT_PREFS, ...stored };
  }

  async update(patch: Partial<UserPreferences>): Promise<UserPreferences> {
    const current = await this.get();
    const updated = { ...current, ...patch };
    await this.storage.set(this.PREFS_KEY, updated);
    return updated;
  }

  async reset(): Promise<void> {
    await this.storage.delete(this.PREFS_KEY);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. REACT NAVIGATION TYPE-SAFE ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// Simulates React Navigation's route param types
type RootStackParamList = {
  Home:         undefined;
  NoteDetail:   { noteId: string; readOnly?: boolean };
  NoteEdit:     { noteId?: string; templateId?: string };
  Settings:     undefined;
  AIChat:       { sessionId: string; contextNoteIds?: string[] };
  OfflineQueue: undefined;
};

type RouteName = keyof RootStackParamList;
type RouteParams<T extends RouteName> = RootStackParamList[T];

// Type-safe navigation action
interface NavigationAction<T extends RouteName> {
  type: "navigate" | "push" | "replace" | "goBack";
  screen: T;
  params: RouteParams<T>;
}

function navigate<T extends RouteName>(
  screen: T,
  params: RouteParams<T>,
): NavigationAction<T> {
  return { type: "navigate", screen, params };
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. OFFLINE SYNC ADAPTER (mobile-specific patterns)
// ─────────────────────────────────────────────────────────────────────────────

interface SyncableEntity {
  id: string;
  updatedAt: string;
  version: number;
  synced: boolean;
}

interface Note extends SyncableEntity {
  title: string;
  body: string;
  authorId: string;
}

class MobileSyncAdapter<T extends SyncableEntity> {
  private pendingQueue: T[] = [];

  constructor(
    private readonly db: DatabaseAdapter<T>,
    private readonly network: NetworkAdapter,
    private readonly endpoint: string,
  ) {}

  /** Save locally first, mark as unsynced */
  async saveOffline(entity: T): Promise<T> {
    const unsynced: T = { ...entity, synced: false };
    await this.db.save(unsynced);
    this.pendingQueue.push(unsynced);
    return unsynced;
  }

  /** Flush pending changes to server */
  async syncToServer(): Promise<{ synced: number; failed: number }> {
    let synced = 0, failed = 0;
    const batch = [...this.pendingQueue];

    for (const entity of batch) {
      try {
        const serverVersion = await this.network.put<T>(
          `${this.endpoint}/${entity.id}`,
          entity,
        );
        const confirmed: T = { ...serverVersion, synced: true };
        await this.db.save(confirmed);
        this.pendingQueue = this.pendingQueue.filter(e => e.id !== entity.id);
        synced++;
      } catch {
        failed++;
      }
    }
    return { synced, failed };
  }

  /** Pull changes from server since last sync */
  async syncFromServer(since: string): Promise<T[]> {
    const serverItems = await this.network.get<T[]>(`${this.endpoint}?since=${since}`);
    for (const item of serverItems) {
      await this.db.save({ ...item, synced: true });
    }
    return serverItems;
  }

  get pendingCount(): number { return this.pendingQueue.length; }
}

// ─────────────────────────────────────────────────────────────────────────────
// IN-MEMORY IMPLEMENTATIONS FOR DEMO
// ─────────────────────────────────────────────────────────────────────────────

class InMemoryDB<T extends { id: string }> implements DatabaseAdapter<T> {
  private store = new Map<string, T>();
  async find(id: string): Promise<T | null>          { return this.store.get(id) ?? null; }
  async findAll(filter?: Partial<T>): Promise<T[]>   {
    const all = [...this.store.values()];
    if (!filter) return all;
    return all.filter(item => Object.entries(filter).every(([k, v]) => (item as Record<string, unknown>)[k] === v));
  }
  async save(entity: T): Promise<T>                   { this.store.set(entity.id, entity); return entity; }
  async delete(id: string): Promise<void>             { this.store.delete(id); }
  async count(): Promise<number>                      { return this.store.size; }
}

class MockNetworkAdapter implements NetworkAdapter {
  private serverData = new Map<string, unknown>();

  async get<T>(url: string): Promise<T> {
    const data = this.serverData.get(url);
    return (data ?? []) as T;
  }
  async post<T>(url: string, body: unknown): Promise<T> {
    const entity = body as { id: string };
    this.serverData.set(`${url}/${entity.id}`, entity);
    return entity as T;
  }
  async put<T>(url: string, body: unknown): Promise<T> {
    this.serverData.set(url, body);
    console.log(`    [Network] PUT ${url}`);
    return body as T;
  }
  async delete(url: string): Promise<void> { this.serverData.delete(url); }
}

// ─────────────────────────────────────────────────────────────────────────────
// DEMO / RUN
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n══════════════════════════════════════");
  console.log(" Bài 12: Cross-Platform Mobile (Adapter Pattern)");
  console.log("══════════════════════════════════════\n");

  // ── Storage Adapters ──
  console.log("[Storage Adapters — same API, different backends]");

  const webStorage    = new InMemoryStorageAdapter();
  const mobileStorage = new MMKVStorageAdapter();

  const webPrefs    = new UserPreferencesService(webStorage);
  const mobilePrefs = new UserPreferencesService(mobileStorage);

  await webPrefs.update({ theme: "dark", language: "vi" });
  await mobilePrefs.update({ theme: "dark", offlineMode: true, aiProvider: "anthropic" });

  console.log("  Web prefs:", await webPrefs.get());
  console.log("  Mobile prefs:", await mobilePrefs.get());

  // ── Type-safe Navigation ──
  console.log("\n[Type-safe Navigation]");
  const navActions = [
    navigate("NoteDetail", { noteId: "note_1", readOnly: false }),
    navigate("AIChat",     { sessionId: "sess_42", contextNoteIds: ["note_1", "note_2"] }),
    navigate("Settings",   undefined),
  ];
  navActions.forEach(a => console.log(`  → ${a.screen}`, JSON.stringify(a.params)));

  // ── Mobile Sync Adapter ──
  console.log("\n[Offline Sync Adapter]");
  const db      = new InMemoryDB<Note>();
  const network = new MockNetworkAdapter();
  const sync    = new MobileSyncAdapter<Note>(db, network, "/api/notes");

  const note1: Note = { id: "n1", title: "Offline note", body: "Written offline", authorId: "usr_1", updatedAt: new Date().toISOString(), version: 1, synced: false };
  const note2: Note = { id: "n2", title: "Another note", body: "Also offline",    authorId: "usr_1", updatedAt: new Date().toISOString(), version: 1, synced: false };

  await sync.saveOffline(note1);
  await sync.saveOffline(note2);
  console.log(`  Pending sync: ${sync.pendingCount}`);

  const { synced, failed } = await sync.syncToServer();
  console.log(`  Synced: ${synced}, Failed: ${failed}, Remaining: ${sync.pendingCount}`);

  const dbCount = await db.count();
  console.log(`  DB contains ${dbCount} notes`);

  console.log("\n✅ Bài 12 hoàn thành!\n");
}

main().catch(console.error);

export {};

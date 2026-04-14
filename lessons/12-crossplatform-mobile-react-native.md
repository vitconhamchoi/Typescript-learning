# Bài 12: Cross-Platform Mobile với React Native & Expo

## Mục tiêu bài học

- Chia sẻ business logic TypeScript giữa Web và Mobile
- Offline-first với MMKV, SQLite, và WatermelonDB trên mobile
- Adapting AI features cho mobile UX
- Code sharing strategy: monorepo với Nx/Turborepo
- Native modules và bridge TypeScript

---

## 12.1 Shared Business Logic Architecture

```
packages/
├── core/                     # Shared TypeScript logic
│   ├── src/
│   │   ├── ai/              # LLM client, chains, tools
│   │   ├── offline/         # Storage adapters, sync
│   │   ├── models/          # Domain models
│   │   └── utils/           # Shared utilities
├── web/                     # React web app
│   └── src/
│       └── adapters/        # Web-specific: IndexedDB, WebSocket
├── mobile/                  # React Native app
│   └── src/
│       └── adapters/        # Mobile-specific: SQLite, MMKV
└── shared-ui/               # Cross-platform UI components
```

```typescript
// packages/core/src/ai/llm-client.ts
// Completely platform-agnostic

export interface HTTPClient {
  post(url: string, body: unknown, headers?: Record<string, string>): Promise<{
    status: number;
    body: unknown;
  }>;
  stream(url: string, body: unknown, headers?: Record<string, string>): AsyncIterable<string>;
}

export interface StorageAdapter {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  keys(prefix?: string): Promise<string[]>;
  clear(): Promise<void>;
}

export interface CryptoAdapter {
  randomUUID(): string;
  hash(input: string): Promise<string>;
  encrypt(data: string, key: string): Promise<string>;
  decrypt(data: string, key: string): Promise<string>;
}

// Platform-agnostic LLM Client
export class LLMClient {
  constructor(
    private http: HTTPClient,
    private config: {
      baseUrl: string;
      apiKey: string;
      defaultModel: string;
    }
  ) {}

  async complete(
    messages: Array<{ role: string; content: string }>,
    options?: { model?: string; temperature?: number; maxTokens?: number }
  ): Promise<{ content: string; usage: { promptTokens: number; completionTokens: number } }> {
    const response = await this.http.post(
      `${this.config.baseUrl}/chat/completions`,
      {
        model: options?.model ?? this.config.defaultModel,
        messages,
        temperature: options?.temperature ?? 0.7,
        max_tokens: options?.maxTokens ?? 2048,
      },
      {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
      }
    );

    const data = response.body as {
      choices: Array<{ message: { content: string } }>;
      usage: { prompt_tokens: number; completion_tokens: number };
    };

    return {
      content: data.choices[0].message.content,
      usage: {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
      },
    };
  }

  async *stream(
    messages: Array<{ role: string; content: string }>,
    options?: { model?: string; temperature?: number }
  ): AsyncIterable<string> {
    const chunks = this.http.stream(
      `${this.config.baseUrl}/chat/completions`,
      {
        model: options?.model ?? this.config.defaultModel,
        messages,
        stream: true,
        temperature: options?.temperature ?? 0.7,
      },
      {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
      }
    );

    for await (const chunk of chunks) {
      if (chunk.includes('"delta"')) {
        try {
          const data = JSON.parse(chunk.replace("data: ", "")) as {
            choices: Array<{ delta: { content?: string } }>;
          };
          const content = data.choices[0]?.delta?.content;
          if (content) yield content;
        } catch {
          // Skip malformed chunks
        }
      }
    }
  }
}

// Platform-agnostic ConversationService
export class ConversationService {
  constructor(
    private storage: StorageAdapter,
    private crypto: CryptoAdapter,
    private llm: LLMClient
  ) {}

  async createConversation(params: {
    userId: string;
    title: string;
    systemPrompt?: string;
  }): Promise<Conversation> {
    const id = this.crypto.randomUUID();
    const conversation: Conversation = {
      id,
      userId: params.userId,
      title: params.title,
      systemPrompt: params.systemPrompt ?? "You are a helpful assistant.",
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      syncStatus: "pending",
    };
    
    await this.storage.set(`conv:${id}`, conversation);
    return conversation;
  }

  async sendMessage(
    conversationId: string,
    content: string
  ): Promise<{ userMessage: Message; assistantMessage: Message }> {
    const conversation = await this.storage.get<Conversation>(`conv:${conversationId}`);
    if (!conversation) throw new Error("Conversation not found");

    const userMsg: Message = {
      id: this.crypto.randomUUID(),
      conversationId,
      role: "user",
      content,
      createdAt: new Date().toISOString(),
      tokenCount: Math.ceil(content.length / 4),
    };

    conversation.messages.push(userMsg);

    // Build messages for LLM
    const llmMessages = [
      { role: "system" as const, content: conversation.systemPrompt },
      ...conversation.messages.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    ];

    const response = await this.llm.complete(llmMessages);

    const assistantMsg: Message = {
      id: this.crypto.randomUUID(),
      conversationId,
      role: "assistant",
      content: response.content,
      createdAt: new Date().toISOString(),
      tokenCount: response.usage.completionTokens,
    };

    conversation.messages.push(assistantMsg);
    conversation.updatedAt = new Date().toISOString();
    conversation.syncStatus = "pending";

    await this.storage.set(`conv:${conversationId}`, conversation);

    return { userMessage: userMsg, assistantMessage: assistantMsg };
  }

  async getConversations(userId: string): Promise<Conversation[]> {
    const keys = await this.storage.keys("conv:");
    const conversations = await Promise.all(
      keys.map((k) => this.storage.get<Conversation>(k))
    );
    return conversations
      .filter((c): c is Conversation => c !== null && c.userId === userId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}

interface Conversation {
  id: string;
  userId: string;
  title: string;
  systemPrompt: string;
  messages: Message[];
  createdAt: string;
  updatedAt: string;
  syncStatus: "synced" | "pending" | "conflict";
}

interface Message {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  tokenCount: number;
}
```

---

## 12.2 Platform-Specific Adapters

```typescript
// ===== WEB ADAPTER =====
// packages/web/src/adapters/web-storage.ts

export class IndexedDBStorageAdapter implements StorageAdapter {
  private db: IDBDatabase | null = null;

  async init(): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("ai-app", 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore("store");
      };
      req.onsuccess = () => {
        this.db = req.result;
        resolve();
      };
      req.onerror = () => reject(req.error);
    });
  }

  async get<T>(key: string): Promise<T | null> {
    if (!this.db) return null;
    return new Promise((resolve) => {
      const tx = this.db!.transaction("store", "readonly");
      const req = tx.objectStore("store").get(key);
      req.onsuccess = () => resolve(req.result as T ?? null);
      req.onerror = () => resolve(null);
    });
  }

  async set<T>(key: string, value: T): Promise<void> {
    if (!this.db) return;
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction("store", "readwrite");
      tx.objectStore("store").put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async delete(key: string): Promise<void> {
    if (!this.db) return;
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction("store", "readwrite");
      tx.objectStore("store").delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async keys(prefix?: string): Promise<string[]> {
    if (!this.db) return [];
    return new Promise((resolve) => {
      const tx = this.db!.transaction("store", "readonly");
      const req = tx.objectStore("store").getAllKeys();
      req.onsuccess = () => {
        const keys = req.result as string[];
        resolve(prefix ? keys.filter((k) => k.startsWith(prefix)) : keys);
      };
      req.onerror = () => resolve([]);
    });
  }

  async clear(): Promise<void> {
    if (!this.db) return;
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction("store", "readwrite");
      tx.objectStore("store").clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}

export class WebCryptoAdapter implements CryptoAdapter {
  randomUUID(): string {
    return crypto.randomUUID();
  }

  async hash(input: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(input);
    const hash = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  async encrypt(data: string, key: string): Promise<string> {
    const keyBuffer = await this.deriveKey(key);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoder = new TextEncoder();
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      keyBuffer,
      encoder.encode(data)
    );
    const combined = new Uint8Array(iv.length + encrypted.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(encrypted), iv.length);
    return btoa(String.fromCharCode(...combined));
  }

  async decrypt(data: string, key: string): Promise<string> {
    const combined = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const iv = combined.slice(0, 12);
    const encrypted = combined.slice(12);
    const keyBuffer = await this.deriveKey(key);
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      keyBuffer,
      encrypted
    );
    return new TextDecoder().decode(decrypted);
  }

  private async deriveKey(password: string): Promise<CryptoKey> {
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      encoder.encode(password),
      "PBKDF2",
      false,
      ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: encoder.encode("ai-app-salt"),
        iterations: 100000,
        hash: "SHA-256",
      },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }
}

// ===== REACT NATIVE ADAPTER =====
// packages/mobile/src/adapters/rn-storage.ts

// Note: In actual RN project, import from:
// import MMKV from 'react-native-mmkv';
// import SQLite from 'react-native-sqlite-storage';

interface MMKVInterface {
  getString(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
  getAllKeys(): string[];
  clearAll(): void;
}

// MMKV-based storage adapter (fastest React Native storage)
export class MMKVStorageAdapter implements StorageAdapter {
  constructor(private mmkv: MMKVInterface) {}

  async get<T>(key: string): Promise<T | null> {
    const value = this.mmkv.getString(key);
    if (!value) return null;
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.mmkv.set(key, JSON.stringify(value));
  }

  async delete(key: string): Promise<void> {
    this.mmkv.delete(key);
  }

  async keys(prefix?: string): Promise<string[]> {
    const allKeys = this.mmkv.getAllKeys();
    return prefix ? allKeys.filter((k) => k.startsWith(prefix)) : allKeys;
  }

  async clear(): Promise<void> {
    this.mmkv.clearAll();
  }
}
```

---

## 12.3 Cross-Platform React Hooks

```typescript
// packages/shared-ui/src/hooks/useConversations.ts
// Works on BOTH Web and React Native!

interface UseConversationsOptions {
  userId: string;
  conversationService: ConversationService;
}

// Platform-agnostic hook interface
interface ConversationsState {
  conversations: Conversation[];
  isLoading: boolean;
  error: string | null;
  currentConversation: Conversation | null;
}

interface ConversationsActions {
  createConversation: (title: string) => Promise<Conversation>;
  sendMessage: (content: string) => Promise<void>;
  selectConversation: (id: string) => void;
  refreshConversations: () => Promise<void>;
}

// This hook works with ANY state management (React, Zustand, etc.)
// In React:
// function useConversations(options: UseConversationsOptions) {
//   const [state, setState] = useState<ConversationsState>({...});
//   ... 
// }

// ===== REACT NATIVE SPECIFIC UI PATTERNS =====

// Streaming message component (React Native)
interface StreamingMessageProps {
  onStream: () => AsyncIterable<string>;
  onComplete: (fullText: string) => void;
}

// In React Native component:
// function StreamingMessage({ onStream, onComplete }: StreamingMessageProps) {
//   const [text, setText] = useState('');
//   const [isStreaming, setIsStreaming] = useState(false);
//   
//   const startStreaming = useCallback(async () => {
//     setIsStreaming(true);
//     let full = '';
//     for await (const chunk of onStream()) {
//       full += chunk;
//       setText(full);
//     }
//     setIsStreaming(false);
//     onComplete(full);
//   }, [onStream, onComplete]);
//   
//   return (
//     <View>
//       <Text>{text}</Text>
//       {isStreaming && <ActivityIndicator />}
//     </View>
//   );
// }

// WatermelonDB for offline-first mobile database
// In production: much better than MMKV for complex queries

interface WatermelonSchema {
  version: number;
  tables: WatermelonTableSchema[];
}

interface WatermelonTableSchema {
  name: string;
  columns: Array<{
    name: string;
    type: "string" | "number" | "boolean";
    isOptional?: boolean;
    isIndexed?: boolean;
  }>;
}

const AIAppSchema: WatermelonSchema = {
  version: 1,
  tables: [
    {
      name: "conversations",
      columns: [
        { name: "user_id", type: "string", isIndexed: true },
        { name: "title", type: "string" },
        { name: "model_id", type: "string" },
        { name: "system_prompt", type: "string" },
        { name: "is_archived", type: "boolean" },
        { name: "is_pinned", type: "boolean" },
        { name: "total_tokens", type: "number" },
        { name: "sync_status", type: "string" },
        { name: "created_at", type: "number" },
        { name: "updated_at", type: "number" },
      ],
    },
    {
      name: "messages",
      columns: [
        { name: "conversation_id", type: "string", isIndexed: true },
        { name: "role", type: "string" },
        { name: "content", type: "string" },
        { name: "token_count", type: "number" },
        { name: "model", type: "string", isOptional: true },
        { name: "sync_status", type: "string" },
        { name: "created_at", type: "number" },
      ],
    },
    {
      name: "embeddings",
      columns: [
        { name: "document_id", type: "string", isIndexed: true },
        { name: "content", type: "string" },
        { name: "vector_json", type: "string" }, // JSON serialized Float32Array
        { name: "model", type: "string" },
        { name: "dimensions", type: "number" },
      ],
    },
  ],
};
```

---

## 12.4 Mobile-Specific AI Features

```typescript
// Voice input processing (React Native)
interface AudioTranscription {
  text: string;
  confidence: number;
  language: string;
  segments: Array<{ start: number; end: number; text: string }>;
}

class MobileVoiceAIService {
  constructor(
    private transcriber: { transcribe(audioPath: string): Promise<AudioTranscription> },
    private llm: LLMClient
  ) {}

  async processVoiceMessage(audioPath: string): Promise<{
    transcription: AudioTranscription;
    response: string;
  }> {
    // Step 1: Transcribe audio to text
    const transcription = await this.transcriber.transcribe(audioPath);
    
    // Step 2: Send to LLM
    const response = await this.llm.complete([
      { role: "system", content: "You are a helpful voice assistant. Be concise." },
      { role: "user", content: transcription.text },
    ]);

    return { transcription, response: response.content };
  }
}

// Battery-aware AI (mobile optimization)
interface BatteryInfo {
  level: number;      // 0-1
  isCharging: boolean;
  isLowPower: boolean;
}

class BatteryAwareAIConfig {
  getOptimalConfig(battery: BatteryInfo): {
    model: string;
    maxTokens: number;
    enableStreaming: boolean;
    cacheAggressively: boolean;
  } {
    if (battery.isLowPower || battery.level < 0.2) {
      return {
        model: "gpt-4o-mini",      // Cheaper, faster
        maxTokens: 512,              // Shorter responses
        enableStreaming: false,      // Less network overhead
        cacheAggressively: true,     // Use cache more
      };
    }

    if (!battery.isCharging && battery.level < 0.5) {
      return {
        model: "gpt-4o-mini",
        maxTokens: 1024,
        enableStreaming: true,
        cacheAggressively: false,
      };
    }

    return {
      model: "gpt-4o",
      maxTokens: 4096,
      enableStreaming: true,
      cacheAggressively: false,
    };
  }
}

// Network-aware sync (mobile)
interface NetworkInfo {
  type: "wifi" | "cellular" | "ethernet" | "none";
  isConnected: boolean;
  effectiveType?: "2g" | "3g" | "4g" | "5g";
}

class NetworkAwareSyncManager {
  shouldSync(network: NetworkInfo): boolean {
    if (!network.isConnected) return false;
    return true; // Sync on any connection
  }

  getSyncStrategy(network: NetworkInfo): "full" | "delta" | "defer" {
    if (!network.isConnected) return "defer";
    if (network.type === "wifi") return "full";
    if (network.effectiveType === "4g" || network.effectiveType === "5g") return "delta";
    return "defer"; // 2g/3g: defer non-critical sync
  }

  getDownloadStrategy(network: NetworkInfo): {
    downloadModels: boolean;
    prefetchEmbeddings: boolean;
    syncAttachments: boolean;
  } {
    if (network.type === "wifi") {
      return {
        downloadModels: true,        // OK to download large models on WiFi
        prefetchEmbeddings: true,
        syncAttachments: true,
      };
    }
    return {
      downloadModels: false,         // Don't use cellular for large downloads
      prefetchEmbeddings: false,
      syncAttachments: false,
    };
  }
}
```

---

## 12.5 Expo Configuration cho AI App

```typescript
// app.config.ts — Expo configuration
import { ExpoConfig, ConfigContext } from "expo/config";

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: "AI Assistant",
  slug: "ai-assistant",
  version: "1.0.0",
  orientation: "portrait",
  
  ios: {
    bundleIdentifier: "com.example.aiassistant",
    buildNumber: "1",
    infoPlist: {
      NSMicrophoneUsageDescription: "Used for voice messages",
      NSCameraUsageDescription: "Used for image analysis",
      NSPhotoLibraryUsageDescription: "Used for image selection",
      UIBackgroundModes: ["fetch", "remote-notification"],
    },
    entitlements: {
      "com.apple.developer.networking.wifi-info": true,
    },
  },

  android: {
    package: "com.example.aiassistant",
    versionCode: 1,
    permissions: [
      "android.permission.RECORD_AUDIO",
      "android.permission.CAMERA",
      "android.permission.READ_EXTERNAL_STORAGE",
      "android.permission.RECEIVE_BOOT_COMPLETED",   // For background sync
      "android.permission.FOREGROUND_SERVICE",
    ],
    googleServicesFile: "./google-services.json",
  },

  plugins: [
    "expo-router",
    "expo-sqlite",
    [
      "expo-notifications",
      {
        icon: "./assets/notification-icon.png",
        color: "#7C3AED",
      },
    ],
    [
      "@shopify/react-native-mmkv",
      { mode: "SINGLE_PROCESS" },
    ],
  ],

  extra: {
    apiUrl: process.env.API_URL,
    wsUrl: process.env.WS_URL,
    openaiApiKey: process.env.OPENAI_API_KEY,
    eas: {
      projectId: "your-project-id",
    },
  },

  updates: {
    enabled: true,
    checkAutomatically: "ON_LOAD",
    fallbackToCacheTimeout: 0,
  },
});
```

---

## Tóm tắt Bài 12

| Concern | Web | React Native |
|---------|-----|-------------|
| Storage | IndexedDB (Dexie) | MMKV + WatermelonDB |
| Network | fetch + WebSocket | Same + NetInfo |
| Crypto | Web Crypto API | react-native-crypto |
| Background | Service Worker | Background Fetch |
| Push | Web Push API | Expo Notifications |
| Voice | MediaRecorder | expo-av |

**Code sharing rate: ~70-80% với adapter pattern!**

## Bài tập thực hành

1. Implement **Offline Queue cho mobile**: khi không có mạng, store messages locally với MMKV, auto-sync khi online.
2. Xây dựng **Share extension**: cho phép share text/image từ app khác vào AI assistant.
3. Implement **Biometric Auth**: dùng Face ID/Touch ID để bảo vệ AI conversations với expo-local-authentication.

---

*Tiếp theo: [Bài 13 — GraphQL API Gateway](13-graphql-api-gateway.md)*

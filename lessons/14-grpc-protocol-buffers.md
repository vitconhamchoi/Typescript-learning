# Bài 14: gRPC & Protocol Buffers với TypeScript

## Mục tiêu bài học

- Thiết kế Protocol Buffer schemas cho AI services
- Implement gRPC server và client với Node.js
- Bidirectional streaming cho real-time AI responses
- gRPC-Web cho browser clients
- Service mesh integration với gRPC

---

## 14.1 Protocol Buffer Schema Design

```protobuf
// proto/ai_service.proto
syntax = "proto3";

package ai.v1;

option java_package = "com.example.ai.v1";
option go_package = "github.com/example/ai/v1";

// ============ COMMON MESSAGES ============

message Timestamp {
  int64 seconds = 1;
  int32 nanos = 2;
}

message TokenUsage {
  int32 prompt_tokens = 1;
  int32 completion_tokens = 2;
  int32 total_tokens = 3;
  double estimated_cost_usd = 4;
}

message Error {
  string code = 1;
  string message = 2;
  map<string, string> details = 3;
}

// ============ CONVERSATION SERVICE ============

message Message {
  string id = 1;
  string conversation_id = 2;
  string role = 3;  // user | assistant | system | tool
  string content = 4;
  Timestamp created_at = 5;
  int32 token_count = 6;
  optional string model = 7;
  repeated ToolCall tool_calls = 8;
}

message ToolCall {
  string id = 1;
  string name = 2;
  string arguments_json = 3;  // JSON string
}

message Conversation {
  string id = 1;
  string user_id = 2;
  string title = 3;
  string model_id = 4;
  string system_prompt = 5;
  repeated Message messages = 6;
  Timestamp created_at = 7;
  Timestamp updated_at = 8;
  bool is_archived = 9;
  int32 total_tokens = 10;
  TokenUsage usage = 11;
}

message CreateConversationRequest {
  string user_id = 1;
  string title = 2;
  optional string model_id = 3;
  optional string system_prompt = 4;
}

message CreateConversationResponse {
  Conversation conversation = 1;
}

message GetConversationRequest {
  string id = 1;
  string user_id = 2;
}

message ListConversationsRequest {
  string user_id = 1;
  int32 limit = 2;
  int32 offset = 3;
  optional string search_query = 4;
  optional bool include_archived = 5;
}

message ListConversationsResponse {
  repeated Conversation conversations = 1;
  int32 total_count = 2;
  bool has_more = 3;
}

message SendMessageRequest {
  string conversation_id = 1;
  string user_id = 2;
  string content = 3;
  optional string model = 4;
  optional double temperature = 5;
  optional int32 max_tokens = 6;
  bool stream = 7;
}

message SendMessageResponse {
  Message message = 1;
  TokenUsage usage = 2;
  int64 latency_ms = 3;
}

message StreamChunk {
  string conversation_id = 1;
  string message_id = 2;
  string delta = 3;
  optional string finish_reason = 4;
  optional TokenUsage usage = 5;
  bool is_final = 6;
}

// ============ LLM SERVICE ============

message CompletionRequest {
  string model = 1;
  repeated Message messages = 2;
  double temperature = 3;
  int32 max_tokens = 4;
  repeated Tool tools = 5;
  string tool_choice = 6;
  optional string response_format = 7;
  repeated string stop_sequences = 8;
}

message Tool {
  string name = 1;
  string description = 2;
  string parameters_schema_json = 3;  // JSON Schema
}

message CompletionResponse {
  string id = 1;
  string model = 2;
  string content = 3;
  repeated ToolCall tool_calls = 4;
  string finish_reason = 5;
  TokenUsage usage = 6;
  int64 latency_ms = 7;
}

// ============ EMBEDDING SERVICE ============

message EmbedRequest {
  string model = 1;
  repeated string texts = 2;
  optional int32 dimensions = 3;
}

message EmbedResponse {
  string model = 1;
  repeated EmbeddingVector embeddings = 2;
  TokenUsage usage = 3;
}

message EmbeddingVector {
  string text = 1;
  repeated float values = 2;
  int32 dimensions = 3;
  int32 index = 4;
}

// ============ SERVICE DEFINITIONS ============

service ConversationService {
  // Unary RPCs
  rpc CreateConversation(CreateConversationRequest) returns (CreateConversationResponse);
  rpc GetConversation(GetConversationRequest) returns (Conversation);
  rpc ListConversations(ListConversationsRequest) returns (ListConversationsResponse);
  
  // Server streaming: real-time AI response
  rpc StreamMessage(SendMessageRequest) returns (stream StreamChunk);
  
  // Bidirectional streaming: interactive conversation
  rpc InteractiveConversation(stream SendMessageRequest) returns (stream StreamChunk);
}

service LLMService {
  // Unary
  rpc Complete(CompletionRequest) returns (CompletionResponse);
  
  // Server streaming
  rpc StreamComplete(CompletionRequest) returns (stream StreamChunk);
}

service EmbeddingService {
  rpc Embed(EmbedRequest) returns (EmbedResponse);
  
  // Client streaming: batch embed many texts
  rpc BatchEmbed(stream EmbedRequest) returns (EmbedResponse);
}
```

---

## 14.2 gRPC Server Implementation với TypeScript

```typescript
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import path from "path";

// Load proto definitions
const packageDefinition = protoLoader.loadSync(
  path.join(__dirname, "proto/ai_service.proto"),
  {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  }
);

const protoDescriptor = grpc.loadPackageDefinition(packageDefinition);
const aiProto = (protoDescriptor.ai as { v1: { ConversationService: grpc.ServiceClientConstructor; LLMService: grpc.ServiceClientConstructor } }).v1;

// TypeScript interfaces matching proto types
interface ProtoMessage {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  created_at: { seconds: string; nanos: number };
  token_count: number;
  model?: string;
}

interface ProtoConversation {
  id: string;
  user_id: string;
  title: string;
  model_id: string;
  system_prompt: string;
  messages: ProtoMessage[];
  is_archived: boolean;
  total_tokens: number;
}

interface ProtoStreamChunk {
  conversation_id: string;
  message_id: string;
  delta: string;
  finish_reason?: string;
  is_final: boolean;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

// gRPC Server Handlers
class ConversationGRPCHandler {
  constructor(
    private conversationService: {
      create(userId: string, params: { title: string; modelId: string }): Promise<ProtoConversation>;
      findById(id: string): Promise<ProtoConversation | null>;
      findByUser(userId: string, params: { limit: number; offset: number }): Promise<ProtoConversation[]>;
    },
    private llmService: {
      stream(messages: ProtoMessage[], model: string): AsyncIterable<ProtoStreamChunk>;
    }
  ) {}

  // Unary: CreateConversation
  async createConversation(
    call: grpc.ServerUnaryCall<{
      user_id: string;
      title: string;
      model_id: string;
    }, ProtoConversation>,
    callback: grpc.sendUnaryData<ProtoConversation>
  ): Promise<void> {
    try {
      const { user_id, title, model_id } = call.request;
      const conversation = await this.conversationService.create(user_id, {
        title,
        modelId: model_id || "gpt-4o",
      });
      callback(null, conversation);
    } catch (error) {
      callback({
        code: grpc.status.INTERNAL,
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  // Unary: GetConversation
  async getConversation(
    call: grpc.ServerUnaryCall<{ id: string; user_id: string }, ProtoConversation>,
    callback: grpc.sendUnaryData<ProtoConversation>
  ): Promise<void> {
    try {
      const conversation = await this.conversationService.findById(call.request.id);
      if (!conversation) {
        callback({ code: grpc.status.NOT_FOUND, message: "Conversation not found" });
        return;
      }
      callback(null, conversation);
    } catch (error) {
      callback({
        code: grpc.status.INTERNAL,
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  // Server Streaming: StreamMessage
  async streamMessage(
    call: grpc.ServerWritableStream<{
      conversation_id: string;
      content: string;
      model?: string;
    }, ProtoStreamChunk>
  ): Promise<void> {
    const { conversation_id, content, model } = call.request;
    const messageId = crypto.randomUUID();

    try {
      const messages: ProtoMessage[] = [
        {
          id: crypto.randomUUID(),
          conversation_id,
          role: "user",
          content,
          created_at: { seconds: String(Math.floor(Date.now() / 1000)), nanos: 0 },
          token_count: Math.ceil(content.length / 4),
        },
      ];

      for await (const chunk of this.llmService.stream(messages, model ?? "gpt-4o")) {
        if (call.cancelled) break;

        call.write({
          conversation_id,
          message_id: messageId,
          delta: chunk.delta,
          finish_reason: chunk.finish_reason,
          is_final: !!chunk.finish_reason,
          usage: chunk.usage,
        });

        if (chunk.finish_reason) break;
      }

      call.end();
    } catch (error) {
      call.destroy(error as Error);
    }
  }

  // Bidirectional Streaming: InteractiveConversation
  async interactiveConversation(
    call: grpc.ServerDuplexStream<{
      conversation_id: string;
      content: string;
    }, ProtoStreamChunk>
  ): Promise<void> {
    const conversationHistory: ProtoMessage[] = [];

    call.on("data", async (request) => {
      const { conversation_id, content } = request;
      const messageId = crypto.randomUUID();

      const userMessage: ProtoMessage = {
        id: crypto.randomUUID(),
        conversation_id,
        role: "user",
        content,
        created_at: { seconds: String(Math.floor(Date.now() / 1000)), nanos: 0 },
        token_count: Math.ceil(content.length / 4),
      };
      conversationHistory.push(userMessage);

      try {
        let fullResponse = "";
        for await (const chunk of this.llmService.stream(conversationHistory, "gpt-4o")) {
          if (call.cancelled) return;

          fullResponse += chunk.delta;
          call.write({
            conversation_id,
            message_id: messageId,
            delta: chunk.delta,
            is_final: !!chunk.finish_reason,
          });

          if (chunk.finish_reason) break;
        }

        // Add assistant response to history
        conversationHistory.push({
          id: messageId,
          conversation_id,
          role: "assistant",
          content: fullResponse,
          created_at: { seconds: String(Math.floor(Date.now() / 1000)), nanos: 0 },
          token_count: Math.ceil(fullResponse.length / 4),
        });
      } catch (error) {
        call.destroy(error as Error);
      }
    });

    call.on("end", () => {
      call.end();
    });
  }
}

// Create gRPC Server
function createAIGRPCServer(handler: ConversationGRPCHandler): grpc.Server {
  const server = new grpc.Server({
    "grpc.max_send_message_length": 50 * 1024 * 1024, // 50MB
    "grpc.max_receive_message_length": 50 * 1024 * 1024,
    "grpc.keepalive_time_ms": 30000,
    "grpc.keepalive_timeout_ms": 10000,
    "grpc.keepalive_permit_without_calls": 1,
  });

  server.addService(
    (aiProto.ConversationService as unknown as { service: grpc.ServiceDefinition }).service,
    {
      createConversation: handler.createConversation.bind(handler),
      getConversation: handler.getConversation.bind(handler),
      streamMessage: handler.streamMessage.bind(handler),
      interactiveConversation: handler.interactiveConversation.bind(handler),
    }
  );

  // Add TLS in production
  const credentials = process.env.NODE_ENV === "production"
    ? grpc.ServerCredentials.createSsl(
        null, // CA cert
        [{ cert_chain: Buffer.from(""), private_key: Buffer.from("") }]
      )
    : grpc.ServerCredentials.createInsecure();

  server.bindAsync("0.0.0.0:50051", credentials, (error, port) => {
    if (error) throw error;
    console.log(`gRPC server listening on port ${port}`);
  });

  return server;
}
```

---

## 14.3 gRPC Client với Interceptors

```typescript
// Type-safe gRPC client
class ConversationGRPCClient {
  private client: grpc.Client;

  constructor(
    address: string,
    private interceptors: grpc.Interceptor[] = []
  ) {
    const credentials = process.env.NODE_ENV === "production"
      ? grpc.credentials.createSsl()
      : grpc.credentials.createInsecure();

    this.client = new (aiProto.ConversationService as unknown as grpc.ServiceClientConstructor)(
      address,
      credentials,
      {
        interceptors: this.interceptors,
        "grpc.keepalive_time_ms": 30000,
        "grpc.keepalive_timeout_ms": 10000,
      }
    );
  }

  async createConversation(params: {
    userId: string;
    title: string;
    modelId?: string;
  }): Promise<ProtoConversation> {
    return new Promise((resolve, reject) => {
      (this.client as unknown as {
        createConversation(
          req: unknown,
          callback: grpc.requestCallback<ProtoConversation>
        ): void;
      }).createConversation(
        {
          user_id: params.userId,
          title: params.title,
          model_id: params.modelId ?? "gpt-4o",
        },
        (error, response) => {
          if (error) reject(error);
          else resolve(response!);
        }
      );
    });
  }

  // Server streaming client
  async *streamMessage(params: {
    conversationId: string;
    content: string;
    model?: string;
  }): AsyncIterable<ProtoStreamChunk> {
    const call = (this.client as unknown as {
      streamMessage(req: unknown): grpc.ClientReadableStream<ProtoStreamChunk>;
    }).streamMessage({
      conversation_id: params.conversationId,
      content: params.content,
      model: params.model,
    });

    for await (const chunk of call) {
      yield chunk;
    }
  }

  // Bidirectional streaming client
  interactiveConversation(): {
    send(message: { conversationId: string; content: string }): void;
    responses: AsyncIterable<ProtoStreamChunk>;
    end(): void;
  } {
    const call = (this.client as unknown as {
      interactiveConversation(): grpc.ClientDuplexStream<unknown, ProtoStreamChunk>;
    }).interactiveConversation();

    async function* readResponses() {
      for await (const chunk of call) {
        yield chunk;
      }
    }

    return {
      send(message) {
        call.write({
          conversation_id: message.conversationId,
          content: message.content,
        });
      },
      responses: readResponses(),
      end() {
        call.end();
      },
    };
  }

  close(): void {
    this.client.close();
  }
}

// Logging interceptor
function loggingInterceptor(
  options: grpc.InterceptorOptions,
  nextCall: (options: grpc.InterceptorOptions) => grpc.InterceptingCall
): grpc.InterceptingCall {
  const start = Date.now();
  return new grpc.InterceptingCall(nextCall(options), {
    start(metadata, listener, next) {
      next(metadata, {
        onReceiveStatus(status, next) {
          const duration = Date.now() - start;
          console.log(`[gRPC] ${options.method_definition.path} - ${status.code} (${duration}ms)`);
          next(status);
        },
        onReceiveMessage: listener.onReceiveMessage,
        onReceiveMetadata: listener.onReceiveMetadata,
      });
    },
  });
}

// Auth interceptor
function authInterceptor(
  getToken: () => Promise<string>
): grpc.Interceptor {
  return (options, nextCall) => {
    return new grpc.InterceptingCall(nextCall(options), {
      start: async (metadata, listener, next) => {
        const token = await getToken();
        metadata.add("authorization", `Bearer ${token}`);
        next(metadata, listener);
      },
    });
  };
}

// Retry interceptor  
function retryInterceptor(maxRetries: number = 3): grpc.Interceptor {
  return (options, nextCall) => {
    let retries = 0;
    
    function makeCall(listener: grpc.Listener): grpc.InterceptingCall {
      return new grpc.InterceptingCall(nextCall(options), {
        start(metadata, l, next) {
          next(metadata, {
            onReceiveStatus(status, next) {
              const retryable = [
                grpc.status.UNAVAILABLE,
                grpc.status.RESOURCE_EXHAUSTED,
              ];
              
              if (retryable.includes(status.code) && retries < maxRetries) {
                retries++;
                console.log(`[gRPC] Retry ${retries}/${maxRetries}`);
                const delay = Math.pow(2, retries) * 1000;
                setTimeout(() => makeCall(listener), delay);
              } else {
                next(status);
              }
            },
            onReceiveMessage: l.onReceiveMessage,
            onReceiveMetadata: l.onReceiveMetadata,
          });
        },
      });
    }
    
    return new grpc.InterceptingCall(nextCall(options));
  };
}
```

---

## 14.4 gRPC-Web cho Browser Clients

```typescript
// gRPC-Web proxy (Envoy configuration)
/*
static_resources:
  listeners:
    - name: listener_0
      address:
        socket_address:
          address: 0.0.0.0
          port_value: 8080
      filter_chains:
        - filters:
            - name: envoy.filters.network.http_connection_manager
              typed_config:
                "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
                codec_type: AUTO
                stat_prefix: ingress_http
                route_config:
                  virtual_hosts:
                    - name: local_service
                      domains: ["*"]
                      cors:
                        allow_origin_string_match:
                          - prefix: "*"
                        allow_methods: GET, PUT, DELETE, POST, OPTIONS
                        allow_headers: authorization,content-type,grpc-timeout,x-user-agent,x-grpc-web
                      routes:
                        - match:
                            prefix: "/"
                          route:
                            cluster: ai_service
                            timeout: 0s
                http_filters:
                  - name: envoy.filters.http.grpc_web
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.filters.http.grpc_web.v3.GrpcWeb
                  - name: envoy.filters.http.cors
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.filters.http.cors.v3.CorsPolicy
                  - name: envoy.filters.http.router
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.filters.http.router.v3.Router
  clusters:
    - name: ai_service
      connect_timeout: 30s
      type: LOGICAL_DNS
      lb_policy: ROUND_ROBIN
      load_assignment:
        cluster_name: ai_service
        endpoints:
          - lb_endpoints:
              - endpoint:
                  address:
                    socket_address:
                      address: ai-service
                      port_value: 50051
      http2_protocol_options: {}
*/

// Browser gRPC-Web client (using @protobuf-ts/grpcweb-transport)
// import { GrpcWebFetchTransport } from "@protobuf-ts/grpcweb-transport";
// import { ConversationServiceClient } from "./generated/ai_service.client";

// Simulated type for demonstration
interface GrpcWebClient {
  streamMessage(request: {
    conversation_id: string;
    content: string;
  }): {
    responses: AsyncIterable<ProtoStreamChunk>;
    headers: Promise<Record<string, string>>;
    trailers: Promise<Record<string, string>>;
    status: Promise<{ code: number }>;
  };
}

async function useGRPCWebStreaming(
  client: GrpcWebClient,
  conversationId: string,
  message: string,
  onChunk: (delta: string) => void
): Promise<void> {
  const call = client.streamMessage({
    conversation_id: conversationId,
    content: message,
  });

  for await (const chunk of call.responses) {
    onChunk(chunk.delta);
    if (chunk.is_final) break;
  }
}
```

---

## Tóm tắt Bài 14

| Streaming Type | Proto Pattern | Use Case |
|----------------|---------------|---------|
| Unary | Request → Response | CRUD operations |
| Server Streaming | Request → Stream | LLM token streaming |
| Client Streaming | Stream → Response | Batch embedding |
| Bidirectional | Stream ↔ Stream | Interactive conversation |

## Bài tập thực hành

1. Implement **gRPC Health Check**: theo chuẩn gRPC Health Checking Protocol, integrate với Kubernetes liveness/readiness probes.
2. Xây dựng **Proto Schema Registry**: centralized schema versioning, backward compatibility checking.
3. Implement **gRPC Deadlines**: propagate deadlines từ gateway qua tất cả downstream gRPC calls.

---

*Tiếp theo: [Bài 15 — Vector Databases & Semantic Search](15-vector-databases-semantic-search.md)*

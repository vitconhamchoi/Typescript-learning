# Bài 13: GraphQL API Gateway với TypeScript

## Mục tiêu bài học

- Thiết kế GraphQL schema cho AI systems với Code-first approach
- Apollo Federation cho microservices architecture
- GraphQL Subscriptions cho real-time AI streaming
- Persisted queries và DataLoader cho performance
- Schema stitching và federation directives

---

## 13.1 Code-First GraphQL Schema với TypeGraphQL

```typescript
import "reflect-metadata";
import {
  Resolver,
  Query,
  Mutation,
  Subscription,
  Arg,
  Ctx,
  Field,
  ObjectType,
  InputType,
  ID,
  Int,
  Float,
  Root,
  PubSub,
  PubSubEngine,
  Publisher,
} from "type-graphql";

// ============ TYPES ============

@ObjectType()
class TokenUsage {
  @Field(() => Int)
  promptTokens!: number;

  @Field(() => Int)
  completionTokens!: number;

  @Field(() => Int)
  totalTokens!: number;

  @Field(() => Float)
  estimatedCostUSD!: number;
}

@ObjectType()
class Message {
  @Field(() => ID)
  id!: string;

  @Field()
  conversationId!: string;

  @Field()
  role!: string;

  @Field()
  content!: string;

  @Field()
  createdAt!: Date;

  @Field(() => Int)
  tokenCount!: number;

  @Field({ nullable: true })
  model?: string;
}

@ObjectType()
class Conversation {
  @Field(() => ID)
  id!: string;

  @Field()
  userId!: string;

  @Field()
  title!: string;

  @Field()
  modelId!: string;

  @Field(() => [Message])
  messages!: Message[];

  @Field()
  createdAt!: Date;

  @Field()
  updatedAt!: Date;

  @Field()
  isArchived!: boolean;

  @Field(() => Int)
  totalTokens!: number;

  @Field(() => TokenUsage)
  usage!: TokenUsage;
}

@ObjectType()
class AIStreamChunk {
  @Field()
  conversationId!: string;

  @Field()
  messageId!: string;

  @Field()
  delta!: string;

  @Field({ nullable: true })
  finishReason?: string;

  @Field({ nullable: true })
  usage?: TokenUsage;
}

@ObjectType()
class ModelInfo {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field()
  provider!: string;

  @Field(() => Int)
  maxContextTokens!: number;

  @Field(() => Float)
  costPer1kInputTokens!: number;

  @Field(() => Float)
  costPer1kOutputTokens!: number;

  @Field()
  supportsTools!: boolean;

  @Field()
  supportsVision!: boolean;
}

// ============ INPUTS ============

@InputType()
class SendMessageInput {
  @Field()
  conversationId!: string;

  @Field()
  content!: string;

  @Field({ nullable: true })
  model?: string;

  @Field({ nullable: true })
  temperature?: number;
}

@InputType()
class CreateConversationInput {
  @Field()
  title!: string;

  @Field({ nullable: true })
  modelId?: string;

  @Field({ nullable: true })
  systemPrompt?: string;
}

@InputType()
class ConversationFilterInput {
  @Field({ nullable: true })
  searchQuery?: string;

  @Field({ nullable: true })
  includeArchived?: boolean;

  @Field({ nullable: true })
  modelId?: string;
}

// ============ CONTEXT ============

interface GraphQLContext {
  userId: string;
  organizationId: string;
  requestId: string;
  services: {
    conversationService: ConversationServiceInterface;
    llmService: LLMServiceInterface;
    modelRegistry: ModelRegistryInterface;
  };
  loaders: DataLoaders;
}

interface DataLoaders {
  messagesByConversation: { load(conversationId: string): Promise<Message[]> };
  conversationById: { load(id: string): Promise<Conversation | null> };
}

interface ConversationServiceInterface {
  create(userId: string, input: CreateConversationInput): Promise<Conversation>;
  findByUser(userId: string, filter?: ConversationFilterInput): Promise<Conversation[]>;
  findById(id: string): Promise<Conversation | null>;
  archive(id: string): Promise<Conversation>;
  delete(id: string): Promise<boolean>;
}

interface LLMServiceInterface {
  sendMessage(userId: string, input: SendMessageInput): Promise<Message>;
  streamMessage(userId: string, input: SendMessageInput): AsyncIterable<AIStreamChunk>;
}

interface ModelRegistryInterface {
  getAvailableModels(): Promise<ModelInfo[]>;
  getModel(id: string): Promise<ModelInfo | null>;
}

// ============ RESOLVERS ============

const SUBSCRIPTION_TOPICS = {
  AI_STREAM: "AI_STREAM",
  CONVERSATION_UPDATED: "CONVERSATION_UPDATED",
};

@Resolver(Conversation)
class ConversationResolver {
  // Field resolver: load messages lazily via DataLoader
  @Query(() => [Conversation])
  async conversations(
    @Ctx() ctx: GraphQLContext,
    @Arg("filter", { nullable: true }) filter?: ConversationFilterInput
  ): Promise<Conversation[]> {
    return ctx.services.conversationService.findByUser(ctx.userId, filter);
  }

  @Query(() => Conversation, { nullable: true })
  async conversation(
    @Arg("id") id: string,
    @Ctx() ctx: GraphQLContext
  ): Promise<Conversation | null> {
    // DataLoader for batching
    return ctx.loaders.conversationById.load(id);
  }

  @Mutation(() => Conversation)
  async createConversation(
    @Arg("input") input: CreateConversationInput,
    @Ctx() ctx: GraphQLContext
  ): Promise<Conversation> {
    return ctx.services.conversationService.create(ctx.userId, input);
  }

  @Mutation(() => Message)
  async sendMessage(
    @Arg("input") input: SendMessageInput,
    @Ctx() ctx: GraphQLContext,
    @PubSub(SUBSCRIPTION_TOPICS.CONVERSATION_UPDATED) publish: Publisher<Conversation>
  ): Promise<Message> {
    const message = await ctx.services.llmService.sendMessage(ctx.userId, input);
    const conversation = await ctx.services.conversationService.findById(input.conversationId);
    if (conversation) {
      await publish(conversation);
    }
    return message;
  }

  @Mutation(() => Conversation)
  async archiveConversation(
    @Arg("id") id: string,
    @Ctx() ctx: GraphQLContext
  ): Promise<Conversation> {
    return ctx.services.conversationService.archive(id);
  }

  // Subscription for streaming AI responses
  @Subscription(() => AIStreamChunk, {
    topics: SUBSCRIPTION_TOPICS.AI_STREAM,
    filter: ({ payload, args }) =>
      payload.conversationId === args.conversationId,
  })
  aiStream(
    @Root() chunk: AIStreamChunk,
    @Arg("conversationId") _conversationId: string
  ): AIStreamChunk {
    return chunk;
  }

  // Subscription for conversation updates
  @Subscription(() => Conversation, {
    topics: SUBSCRIPTION_TOPICS.CONVERSATION_UPDATED,
    filter: ({ payload, context }) =>
      payload.userId === (context as GraphQLContext).userId,
  })
  conversationUpdated(@Root() conversation: Conversation): Conversation {
    return conversation;
  }
}

@Resolver()
class AIResolver {
  @Mutation(() => Message)
  async streamMessage(
    @Arg("input") input: SendMessageInput,
    @Ctx() ctx: GraphQLContext,
    @PubSub() pubSub: PubSubEngine
  ): Promise<Message> {
    const messageId = crypto.randomUUID();
    let fullContent = "";
    let tokenCount = 0;

    // Start streaming in background
    (async () => {
      try {
        for await (const chunk of ctx.services.llmService.streamMessage(ctx.userId, input)) {
          fullContent += chunk.delta;
          tokenCount += 1; // Approximate

          await pubSub.publish(SUBSCRIPTION_TOPICS.AI_STREAM, {
            conversationId: input.conversationId,
            messageId,
            delta: chunk.delta,
            finishReason: chunk.finishReason ?? null,
            usage: chunk.usage,
          });

          if (chunk.finishReason) break;
        }
      } catch (error) {
        await pubSub.publish(SUBSCRIPTION_TOPICS.AI_STREAM, {
          conversationId: input.conversationId,
          messageId,
          delta: "",
          finishReason: "error",
        });
      }
    })();

    // Return placeholder immediately
    return {
      id: messageId,
      conversationId: input.conversationId,
      role: "assistant",
      content: fullContent || "[Streaming...]",
      createdAt: new Date(),
      tokenCount,
      model: input.model,
    };
  }

  @Query(() => [ModelInfo])
  async availableModels(@Ctx() ctx: GraphQLContext): Promise<ModelInfo[]> {
    return ctx.services.modelRegistry.getAvailableModels();
  }
}
```

---

## 13.2 DataLoader cho N+1 Problem

```typescript
import DataLoader from "dataloader";

// Batch loading conversations
function createConversationLoader(
  conversationService: ConversationServiceInterface
): DataLoader<string, Conversation | null> {
  return new DataLoader(
    async (ids: readonly string[]) => {
      // Single batched DB query instead of N queries
      const conversations = await Promise.all(
        ids.map((id) => conversationService.findById(id))
      );
      return conversations;
    },
    { cache: true, maxBatchSize: 100 }
  );
}

// Batch loading messages by conversation
function createMessagesLoader(
  messageService: { findByConversations(ids: string[]): Promise<Map<string, Message[]>> }
): DataLoader<string, Message[]> {
  return new DataLoader(
    async (conversationIds: readonly string[]) => {
      const messageMap = await messageService.findByConversations([...conversationIds]);
      return conversationIds.map((id) => messageMap.get(id) ?? []);
    },
    { cache: false } // Messages change frequently
  );
}

// Context factory with DataLoaders
function createContext(
  userId: string,
  services: GraphQLContext["services"]
): GraphQLContext {
  return {
    userId,
    organizationId: "",
    requestId: crypto.randomUUID(),
    services,
    loaders: {
      conversationById: createConversationLoader(services.conversationService),
      messagesByConversation: createMessagesLoader({
        async findByConversations(ids) {
          // Batch query implementation
          const map = new Map<string, Message[]>();
          ids.forEach((id) => map.set(id, []));
          return map;
        },
      }),
    },
  };
}
```

---

## 13.3 Apollo Federation cho Microservices

```typescript
// User Service — owns User type
// packages/user-service/src/schema.ts
const userServiceSchema = `
  extend schema @link(url: "https://specs.apollo.dev/federation/v2.0", import: ["@key", "@shareable"])

  type User @key(fields: "id") {
    id: ID!
    name: String!
    email: String!
    plan: UserPlan!
    tokenQuota: TokenQuota!
  }

  type UserPlan {
    name: String!
    monthlyTokenLimit: Int!
    modelsAllowed: [String!]!
  }

  type TokenQuota {
    used: Int!
    limit: Int!
    resetAt: String!
  }

  type Query {
    me: User
    user(id: ID!): User
  }
`;

// AI Service — references User type
// packages/ai-service/src/schema.ts  
const aiServiceSchema = `
  extend schema @link(url: "https://specs.apollo.dev/federation/v2.0", import: ["@key", "@external", "@requires"])

  # Reference User from user-service
  type User @key(fields: "id") {
    id: ID! @external
    conversations: [Conversation!]!
    totalTokensUsed: Int!
  }

  type Conversation @key(fields: "id") {
    id: ID!
    title: String!
    modelId: String!
    messageCount: Int!
    totalTokens: Int!
    createdAt: String!
    updatedAt: String!
    isArchived: Boolean!
    user: User!
  }

  type Message @key(fields: "id") {
    id: ID!
    conversationId: ID!
    role: String!
    content: String!
    tokenCount: Int!
    createdAt: String!
  }

  type Query {
    conversation(id: ID!): Conversation
    conversations(userId: ID!, limit: Int, offset: Int): [Conversation!]!
  }

  type Mutation {
    sendMessage(conversationId: ID!, content: String!, model: String): Message!
    createConversation(title: String!, modelId: String): Conversation!
  }

  type Subscription {
    aiStream(conversationId: ID!): AIStreamChunk!
  }

  type AIStreamChunk {
    conversationId: ID!
    messageId: ID!
    delta: String!
    finishReason: String
  }
`;

// Gateway (Apollo Router) config
const gatewayConfig = `
# Apollo Router configuration (router.yaml)
supergraph:
  listen: 0.0.0.0:4000

sandbox:
  enabled: true

plugins:
  experimental.demand_control:
    enabled: true
    mode: measure

headers:
  all:
    request:
      - propagate:
          named: x-user-id
      - propagate:
          named: x-request-id

traffic_shaping:
  all:
    timeout: 30s
    experimental_retry:
      min_per_sec: 10
      ttl: 10s
      retry_on: "transient-error reset"

coprocessor:
  url: http://auth-service:4001
  router:
    request:
      headers: true
      context: true
    response:
      headers: true
`;
```

---

## 13.4 Persisted Queries & Security

```typescript
// Persisted query map (generated at build time)
const PERSISTED_QUERIES: Record<string, string> = {
  "sha256:abc123": `
    query GetConversations($filter: ConversationFilterInput) {
      conversations(filter: $filter) {
        id
        title
        modelId
        updatedAt
        totalTokens
      }
    }
  `,
  "sha256:def456": `
    mutation SendMessage($input: SendMessageInput!) {
      sendMessage(input: $input) {
        id
        role
        content
        tokenCount
        createdAt
      }
    }
  `,
};

// Apollo Server with persisted queries
import { ApolloServer } from "@apollo/server";
import { buildSchema } from "type-graphql";

async function createAIGateway() {
  const schema = await buildSchema({
    resolvers: [ConversationResolver, AIResolver],
    validate: true,
    pubSub: undefined, // inject PubSub
  });

  const server = new ApolloServer({
    schema,
    plugins: [
      // Persisted queries plugin
      {
        async requestDidStart() {
          return {
            async didResolveOperation({ request, document }) {
              // Log all queries for analytics
              console.log(`[GraphQL] ${request.operationName}`);
            },
          };
        },
      },
    ],
    formatError: (error) => {
      // Don't leak internal errors
      if (error.extensions?.code === "INTERNAL_SERVER_ERROR") {
        return {
          message: "Internal server error",
          extensions: { code: "INTERNAL_SERVER_ERROR" },
        };
      }
      return error;
    },
    // Disable introspection in production
    introspection: process.env.NODE_ENV !== "production",
  });

  return server;
}

// Query complexity limiting
function calculateQueryComplexity(query: string): number {
  // Simple heuristic: count nested fields
  const depth = (query.match(/\{/g) ?? []).length;
  const fieldCount = (query.match(/\w+\s*[\({]/g) ?? []).length;
  return depth * fieldCount;
}

const MAX_QUERY_COMPLEXITY = 100;

function queryComplexityMiddleware(
  query: string,
  variables: Record<string, unknown>
): void {
  const complexity = calculateQueryComplexity(query);
  if (complexity > MAX_QUERY_COMPLEXITY) {
    throw new Error(`Query too complex: ${complexity} > ${MAX_QUERY_COMPLEXITY}`);
  }
}
```

---

## Tóm tắt Bài 13

| Feature | Tool | Benefit |
|---------|------|---------|
| Schema | TypeGraphQL (code-first) | Full TypeScript types |
| Performance | DataLoader | Solve N+1 problem |
| Microservices | Apollo Federation | Independent service deployment |
| Security | Persisted Queries | Prevent arbitrary query execution |
| Real-time | Subscriptions | LLM streaming, live updates |

## Bài tập thực hành

1. Implement **Query Depth Limiting**: reject queries với depth > 5 để prevent DoS.
2. Xây dựng **GraphQL Rate Limiting**: limit per-resolver, không chỉ per-request.
3. Implement **Apollo Studio Integration**: automatic schema validation và breaking change detection.

---

*Tiếp theo: [Bài 14 — gRPC & Protocol Buffers](14-grpc-protocol-buffers.md)*

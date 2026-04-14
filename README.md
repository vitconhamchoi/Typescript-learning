# TypeScript Mastery: Offline-First, Distributed AI Systems

> **Dành cho Senior Developers** muốn học cấp tốc cách xây dựng hệ thống AI hiện đại với TypeScript — từ kiến trúc offline-first, phân tán, đến orchestration và gateway AI.

---

## 🎯 Mục tiêu khóa học

Khóa học 20 bài này được thiết kế cho các **senior developer** muốn:

- Xây dựng ứng dụng **offline-first** với TypeScript, đảm bảo hoạt động không cần mạng và đồng bộ hóa dữ liệu linh hoạt
- Thiết kế **kiến trúc phân tán** với khả năng chịu lỗi bền bỉ (fault tolerance)
- Xây dựng **AI Gateway và Orchestrator** chuyên nghiệp
- **Convert sang mobile app** dễ dàng từ codebase TypeScript hiện có
- Tích hợp **Large Language Models (LLMs)**, RAG, và AI Agents vào sản phẩm thực tế

---

## 📚 Chương trình học

| Bài | Chủ đề | Nội dung chính |
|-----|--------|----------------|
| [01](lessons/01-typescript-advanced-types-ai-foundation.md) | TypeScript Advanced Types & AI Foundation | Conditional types, template literals, infer, mapped types, branded types cho AI |
| [02](lessons/02-offline-first-architecture.md) | Offline-First Architecture Core Concepts | Storage strategies, sync patterns, conflict resolution philosophy |
| [03](lessons/03-local-data-layer-indexeddb-pouchdb.md) | Local-First Data Layer | IndexedDB wrapper, PouchDB, Dexie.js với TypeScript |
| [04](lessons/04-crdts-conflict-free-data.md) | CRDTs — Conflict-Free Replicated Data Types | LWW, G-Counter, OR-Set, Automerge, Yjs |
| [05](lessons/05-service-workers-background-sync.md) | Service Workers & Background Sync | Workbox, sync queue, push notifications, offline caching |
| [06](lessons/06-distributed-systems-fundamentals.md) | Distributed Systems Fundamentals | CAP theorem, eventual consistency, vector clocks, Merkle trees |
| [07](lessons/07-event-sourcing-cqrs.md) | Event Sourcing & CQRS | EventStore, projections, sagas, outbox pattern |
| [08](lessons/08-ai-gateway-design.md) | AI Gateway Design in TypeScript | Rate limiting, routing, caching, multi-provider abstraction |
| [09](lessons/09-llm-orchestration.md) | LLM Orchestration with TypeScript | LangChain.js, prompt chains, streaming, tool calling |
| [10](lessons/10-realtime-sync-websockets-sse.md) | Real-time Sync with WebSockets & SSE | Socket.IO, CRDT sync, presence, multiplayer patterns |
| [11](lessons/11-fault-tolerance-patterns.md) | Fault Tolerance Patterns | Circuit Breaker, Retry, Bulkhead, Timeout, Hedged requests |
| [12](lessons/12-crossplatform-mobile-react-native.md) | Cross-Platform Mobile với React Native | Expo, React Native + TypeScript, code sharing, offline mobile |
| [13](lessons/13-graphql-api-gateway.md) | GraphQL API Gateway | Apollo Federation, schema stitching, persisted queries, subscriptions |
| [14](lessons/14-grpc-protocol-buffers.md) | gRPC & Protocol Buffers | grpc-js, protobuf TypeScript, streaming, bidirectional |
| [15](lessons/15-vector-databases-semantic-search.md) | Vector Databases & Semantic Search | Pinecone, Weaviate, Chroma, embedding models, similarity search |
| [16](lessons/16-rag-implementation.md) | RAG — Retrieval Augmented Generation | Pipeline design, chunking, reranking, hybrid search |
| [17](lessons/17-ai-agent-architecture.md) | AI Agent Architecture | ReAct pattern, tool use, memory, planning, reflection |
| [18](lessons/18-multi-agent-orchestration.md) | Multi-Agent Orchestration | Agent graphs, supervisor, debate, specialized agents |
| [19](lessons/19-testing-ai-systems.md) | Testing AI Systems | Evals, deterministic tests, golden datasets, observability |
| [20](lessons/20-production-deployment-monitoring.md) | Production Deployment & Monitoring | Kubernetes, Prometheus, tracing, cost optimization, A/B testing |

---

## 🏗️ Kiến trúc tổng thể

```
┌─────────────────────────────────────────────────────────────────┐
│                    CLIENT (Web / Mobile)                         │
│  ┌────────────────┐  ┌──────────────────┐  ┌─────────────────┐  │
│  │  UI Layer      │  │  Offline Store   │  │ Service Worker  │  │
│  │  (React/RN)    │  │  (IndexedDB/     │  │ (Cache +        │  │
│  │                │  │   SQLite)        │  │  Background Sync)│  │
│  └───────┬────────┘  └────────┬─────────┘  └────────┬────────┘  │
│          └───────────────────►│◄───────────────────┘            │
└──────────────────────────────┬──────────────────────────────────┘
                               │ HTTP/WS/gRPC
┌──────────────────────────────▼──────────────────────────────────┐
│                    AI GATEWAY / ORCHESTRATOR                     │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────────┐ │
│  │  Rate Limiter│  │  Router      │  │  Auth & Quota Manager  │ │
│  └──────────────┘  └──────┬───────┘  └────────────────────────┘ │
│                           │                                      │
│  ┌────────────────────────▼──────────────────────────────────┐  │
│  │              LLM Orchestrator                             │  │
│  │  ┌──────────┐ ┌──────────┐ ┌─────────┐ ┌─────────────┐  │  │
│  │  │  Prompt  │ │  Chain   │ │  Tools  │ │   Memory    │  │  │
│  │  │ Template │ │  Runner  │ │  Caller │ │   Manager   │  │  │
│  │  └──────────┘ └──────────┘ └─────────┘ └─────────────┘  │  │
│  └───────────────────────────────────────────────────────────┘  │
└──────────────────────────────┬──────────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────────┐
│                    DISTRIBUTED BACKEND                           │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────────┐ │
│  │  Event Store │  │  Vector DB   │  │  Time-Series DB        │ │
│  │  (EventStore │  │  (Pinecone / │  │  (InfluxDB / TimescaleDB)││
│  │   / Kafka)   │  │   Weaviate)  │  │                        │ │
│  └──────────────┘  └──────────────┘  └────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🚀 Cách sử dụng

1. Clone repository này
2. Đọc từng bài theo thứ tự (mỗi bài có code ví dụ đầy đủ)
3. Mỗi bài có phần **"Thực hành"** để bạn tự code
4. Code ví dụ trong mỗi bài là production-ready và có thể copy trực tiếp

## 📋 Yêu cầu tiên quyết

- TypeScript 5.x
- Node.js 20+
- Hiểu biết về React, Node.js, REST APIs
- Kinh nghiệm backend/frontend senior (3+ năm)

---

*Khóa học được biên soạn với tiêu chuẩn chất lượng cao, phù hợp cho senior developers muốn nắm vững TypeScript trong bối cảnh AI và hệ thống phân tán hiện đại.*

import assert from "node:assert/strict";
import test from "node:test";

import type { Todo } from "../../../domain/todos/entities/todo.js";
import type { TodoRepository } from "../../../domain/todos/repositories/todo-repository.js";
import type { Logger } from "../../shared/logger.js";
import type { Monitor } from "../../shared/monitor.js";
import { CreateTodoService } from "./create-todo.service.js";

class MockTodoRepository implements TodoRepository {
  private readonly todosByUserId = new Map<string, Todo[]>();

  async save(todo: Todo): Promise<void> {
    const current = this.todosByUserId.get(todo.userId) ?? [];
    this.todosByUserId.set(todo.userId, [...current, todo]);
  }

  async listByUserId(userId: string): Promise<Todo[]> {
    return this.todosByUserId.get(userId) ?? [];
  }
}

class NoopLogger implements Logger {
  child(_context: Record<string, unknown>): Logger {
    return this;
  }

  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
}

class InMemoryMonitor implements Monitor {
  private readonly counters = new Map<string, number>();
  private readonly timings = new Map<string, number[]>();

  increment(metric: string, value: number = 1): void {
    this.counters.set(metric, (this.counters.get(metric) ?? 0) + value);
  }

  timing(metric: string, valueMs: number): void {
    const current = this.timings.get(metric) ?? [];
    this.timings.set(metric, [...current, valueMs]);
  }

  snapshot(): Readonly<{ counters: Record<string, number>; timings: Record<string, number[]> }> {
    return {
      counters: Object.fromEntries(this.counters),
      timings: Object.fromEntries(this.timings),
    };
  }
}

test("CreateTodoService should create todo with valid payload", async () => {
  const service = new CreateTodoService(new MockTodoRepository(), new NoopLogger(), new InMemoryMonitor());

  const result = await service.execute({
    userId: "user-1",
    title: "Write tests",
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.userId, "user-1");
    assert.equal(result.value.title, "Write tests");
  }
});

test("CreateTodoService.listByUserId should reject empty user id", async () => {
  const service = new CreateTodoService(new MockTodoRepository(), new NoopLogger(), new InMemoryMonitor());

  const result = await service.listByUserId("   ");

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "VALIDATION_ERROR");
  }
});

test("CreateTodoService.listByUserId should return empty list when no todos", async () => {
  const service = new CreateTodoService(new MockTodoRepository(), new NoopLogger(), new InMemoryMonitor());

  const result = await service.listByUserId("user-without-todos");

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.value, []);
  }
});

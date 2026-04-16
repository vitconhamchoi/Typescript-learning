import assert from "node:assert/strict";
import test from "node:test";

import type { UserRepository } from "../../../domain/users/repositories/user-repository.js";
import type { User } from "../../../domain/users/entities/user.js";
import type { Logger } from "../../shared/logger.js";
import type { Monitor } from "../../shared/monitor.js";
import { CreateUserService } from "./create-user.service.js";

class MockUserRepository implements UserRepository {
  private readonly users = new Map<string, User>();

  async findByEmail(email: string): Promise<User | null> {
    return this.users.get(email) ?? null;
  }

  async save(user: User): Promise<void> {
    this.users.set(user.email.value, user);
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

  increment(metric: string, value: number = 1, _tags?: Record<string, string>): void {
    this.counters.set(metric, (this.counters.get(metric) ?? 0) + value);
  }

  timing(metric: string, valueMs: number, _tags?: Record<string, string>): void {
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

test("CreateUserService should create user with valid payload", async () => {
  const service = new CreateUserService(new MockUserRepository(), new NoopLogger(), new InMemoryMonitor());

  const result = await service.execute({
    email: "unit@example.com",
    displayName: "Unit User",
    age: 30,
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.email, "unit@example.com");
    assert.equal(result.value.displayName, "Unit User");
  }
});

import assert from "node:assert/strict";
import test from "node:test";

import { ConsoleLogger } from "../../../../shared/logging/logger.js";
import { InMemoryMonitor } from "../../../../shared/monitoring/monitor.js";
import type { UserRepository } from "../../../users/domain/repositories/user-repository.js";
import type { User } from "../../../users/domain/entities/user.js";
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

test("CreateUserService should create user with valid payload", async () => {
  const service = new CreateUserService(
    new MockUserRepository(),
    new ConsoleLogger({ test: "unit" }),
    new InMemoryMonitor(),
  );

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

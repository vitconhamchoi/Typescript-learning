import type { User } from "../../domain/users/entities/user.js";
import type { UserRepository } from "../../domain/users/repositories/user-repository.js";
import { InMemoryDatabase } from "../database/in-memory-database.js";

export class InMemoryUserRepository implements UserRepository {
  constructor(private readonly db: InMemoryDatabase) {}

  async findByEmail(email: string): Promise<User | null> {
    return this.db.usersByEmail.get(email) ?? null;
  }

  async save(user: User): Promise<void> {
    this.db.usersByEmail.set(user.email.value, user);
  }
}

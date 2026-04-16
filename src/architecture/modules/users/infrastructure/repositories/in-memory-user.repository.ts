import { User } from "../../domain/entities/user.js";
import type { UserRepository } from "../../domain/repositories/user-repository.js";

export class InMemoryUserRepository implements UserRepository {
  private readonly usersByEmail = new Map<string, User>();

  async findByEmail(email: string): Promise<User | null> {
    return this.usersByEmail.get(email) ?? null;
  }

  async save(user: User): Promise<void> {
    this.usersByEmail.set(user.email.value, user);
  }
}

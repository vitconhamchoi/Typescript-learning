import { User } from "../../domain/entities/user.js";
import type { UserRepository } from "../../domain/repositories/user-repository.js";
import { BaseRepository } from "../../../../shared/base/base-repository.js";

export class InMemoryUserRepository
  extends BaseRepository<string, User>
  implements UserRepository
{

  async findByEmail(email: string): Promise<User | null> {
    return this.getByKey(email);
  }

  async save(user: User): Promise<void> {
    this.setByKey(user.email.value, user);
  }
}

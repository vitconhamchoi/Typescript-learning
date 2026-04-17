import type { Todo } from "../../domain/todos/entities/todo.js";
import type { User } from "../../domain/users/entities/user.js";

export class InMemoryDatabase {
  readonly usersByEmail = new Map<string, User>();
  readonly todosByUserId = new Map<string, Todo[]>();
}

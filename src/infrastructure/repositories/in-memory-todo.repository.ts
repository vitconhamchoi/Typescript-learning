import type { Todo } from "../../domain/todos/entities/todo.js";
import type { TodoRepository } from "../../domain/todos/repositories/todo-repository.js";
import { InMemoryDatabase } from "../database/in-memory-database.js";

export class InMemoryTodoRepository implements TodoRepository {
  constructor(private readonly db: InMemoryDatabase) {}

  async save(todo: Todo): Promise<void> {
    const current = this.db.todosByUserId.get(todo.userId) ?? [];
    this.db.todosByUserId.set(todo.userId, [...current, todo]);
  }

  async listByUserId(userId: string): Promise<Todo[]> {
    return this.db.todosByUserId.get(userId) ?? [];
  }
}

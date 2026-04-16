import { Todo } from "../entities/todo.js";

export interface TodoRepository {
  save(todo: Todo): Promise<void>;
  listByUserId(userId: string): Promise<Todo[]>;
}

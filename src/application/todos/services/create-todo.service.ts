import { randomUUID } from "node:crypto";

import { ValidationError, type AppError } from "../../../domain/shared/errors.js";
import { err, ok, type Result } from "../../../domain/shared/result.js";
import { Todo } from "../../../domain/todos/entities/todo.js";
import type { TodoRepository } from "../../../domain/todos/repositories/todo-repository.js";
import { TodoTitle } from "../../../domain/todos/value-objects/todo-title.js";
import type { TodoDto } from "../../shared/contracts/todo.js";
import type { Logger } from "../../shared/logger.js";
import type { Monitor } from "../../shared/monitor.js";

import type { CreateTodoCommand } from "../dto/create-todo.dto.js";

export class CreateTodoService {
  constructor(
    private readonly repository: TodoRepository,
    private readonly logger: Logger,
    private readonly monitor: Monitor,
  ) {}

  async execute(command: CreateTodoCommand): Promise<Result<TodoDto, AppError>> {
    const start = Date.now();

    const titleResult = TodoTitle.create(command.title);
    if (!titleResult.ok) {
      this.monitor.increment("todo.create.validation_error");
      return titleResult;
    }

    const todoResult = Todo.create({
      id: randomUUID(),
      userId: command.userId,
      title: titleResult.value,
      completed: false,
      createdAt: new Date(),
    });

    if (!todoResult.ok) {
      this.monitor.increment("todo.create.validation_error");
      return todoResult;
    }

    await this.repository.save(todoResult.value);

    const dto: TodoDto = {
      id: todoResult.value.id,
      userId: todoResult.value.userId,
      title: todoResult.value.title.value,
      completed: todoResult.value.completed,
      createdAt: todoResult.value.createdAt.toISOString(),
    };

    this.monitor.increment("todo.create.success");
    this.monitor.timing("todo.create.latency_ms", Date.now() - start);
    this.logger.info("Todo created", { todoId: dto.id, userId: dto.userId });

    return ok(dto);
  }

  async listByUserId(userId: string): Promise<Result<TodoDto[], AppError>> {
    if (userId.trim().length === 0) {
      return err(new ValidationError("User id is required"));
    }

    const todos = await this.repository.listByUserId(userId);
    return ok(
      todos.map((todo) => ({
        id: todo.id,
        userId: todo.userId,
        title: todo.title.value,
        completed: todo.completed,
        createdAt: todo.createdAt.toISOString(),
      })),
    );
  }
}

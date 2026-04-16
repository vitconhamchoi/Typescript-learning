import type { AppError } from "../../../domain/shared/errors.js";
import type { Result } from "../../../domain/shared/result.js";
import type { TodoDto } from "../../shared/contracts/todo.js";

import type { CreateTodoCommand } from "../dto/create-todo.dto.js";
import { CreateTodoService } from "../services/create-todo.service.js";

export class CreateTodoUseCase {
  constructor(private readonly createTodoService: CreateTodoService) {}

  execute(command: CreateTodoCommand): Promise<Result<TodoDto, AppError>> {
    return this.createTodoService.execute(command);
  }
}

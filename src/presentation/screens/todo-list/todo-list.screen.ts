import { z } from "zod";

import { ValidationError } from "../../../domain/shared/errors.js";
import { errorResponse, successResponse, type ApiResponse } from "../../../application/shared/contracts/api.js";
import type { CreateTodoResponse } from "../../../application/shared/contracts/todo.js";
import { CreateTodoUseCase } from "../../../application/todos/use-cases/create-todo.use-case.js";

const CreateTodoRequestSchema = z.object({
  userId: z.string().min(1),
  title: z.string().min(3).max(120),
});

export class TodoListScreen {
  constructor(private readonly createTodoUseCase: CreateTodoUseCase) {}

  async create(payload: unknown, requestId: string): Promise<ApiResponse<CreateTodoResponse>> {
    const parsed = CreateTodoRequestSchema.safeParse(payload);
    if (!parsed.success) {
      return errorResponse(
        new ValidationError("Invalid request payload", parsed.error.flatten()),
        requestId,
      );
    }

    const created = await this.createTodoUseCase.execute(parsed.data);
    if (!created.ok) {
      return errorResponse(created.error, requestId);
    }

    return successResponse(created.value, requestId);
  }
}

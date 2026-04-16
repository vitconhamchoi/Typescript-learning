import { z } from "zod";

import { ValidationError } from "../../../domain/shared/errors.js";
import { errorResponse, successResponse, type ApiResponse } from "../../../application/shared/contracts/api.js";
import type { CreateUserResponse } from "../../../application/shared/contracts/user.js";
import { CreateUserUseCase } from "../../../application/users/use-cases/create-user.use-case.js";

const CreateUserRequestSchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(3),
  age: z.number().int().min(13),
});

export class UserProfileScreen {
  constructor(private readonly createUserUseCase: CreateUserUseCase) {}

  async create(payload: unknown, requestId: string): Promise<ApiResponse<CreateUserResponse>> {
    const parsed = CreateUserRequestSchema.safeParse(payload);
    if (!parsed.success) {
      return errorResponse(
        new ValidationError("Invalid request payload", parsed.error.flatten()),
        requestId,
      );
    }

    const created = await this.createUserUseCase.execute(parsed.data);
    if (!created.ok) {
      return errorResponse(created.error, requestId);
    }

    return successResponse(created.value, requestId);
  }
}

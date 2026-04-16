import { ValidationError } from "../../../../shared/errors.js";
import { errorResponse, successResponse, type ApiResponse } from "../../../../shared/contracts/api.js";
import type { CreateUserResponse } from "../../../../shared/contracts/user.js";

import type { CreateUserService } from "../../application/services/create-user.service.js";
import { CreateUserRequestSchema } from "./user.schema.js";

export interface RequestContext {
  requestId: string;
}

export class UsersController {
  constructor(private readonly createUserService: CreateUserService) {}

  async create(
    payload: unknown,
    context: RequestContext,
  ): Promise<ApiResponse<CreateUserResponse>> {
    const parsed = CreateUserRequestSchema.safeParse(payload);
    if (!parsed.success) {
      return errorResponse(
        new ValidationError("Invalid request payload", parsed.error.flatten()),
        context.requestId,
      );
    }

    const created = await this.createUserService.execute(parsed.data);
    if (!created.ok) {
      return errorResponse(created.error, context.requestId);
    }

    return successResponse(created.value, context.requestId);
  }
}

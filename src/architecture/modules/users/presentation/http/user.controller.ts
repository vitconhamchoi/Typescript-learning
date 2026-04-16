import { type ApiResponse } from "../../../../shared/contracts/api.js";
import type { CreateUserResponse } from "../../../../shared/contracts/user.js";
import { BaseController, type RequestContext } from "../../../../shared/base/base-controller.js";

import type { CreateUserService } from "../../application/services/create-user.service.js";
import { CreateUserRequestSchema } from "./user.schema.js";

export class UsersController extends BaseController {
  constructor(private readonly createUserService: CreateUserService) {
    super();
  }

  async create(
    payload: unknown,
    context: RequestContext,
  ): Promise<ApiResponse<CreateUserResponse>> {
    const parsed = CreateUserRequestSchema.safeParse(payload);
    if (!parsed.success) {
      return this.validationFailure("Invalid request payload", parsed.error.flatten(), context);
    }

    return this.toResponse(await this.createUserService.execute(parsed.data), context);
  }
}

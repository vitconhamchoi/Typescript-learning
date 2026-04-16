import type { AppError } from "../../../domain/shared/errors.js";
import type { Result } from "../../../domain/shared/result.js";
import type { UserDto } from "../../shared/contracts/user.js";

import type { CreateUserCommand } from "../dto/create-user.dto.js";
import { CreateUserService } from "../services/create-user.service.js";

export class CreateUserUseCase {
  constructor(private readonly createUserService: CreateUserService) {}

  execute(command: CreateUserCommand): Promise<Result<UserDto, AppError>> {
    return this.createUserService.execute(command);
  }
}

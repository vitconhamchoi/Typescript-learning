import { randomUUID } from "node:crypto";

import type { Logger } from "../../../../shared/logging/logger.js";
import type { Monitor } from "../../../../shared/monitoring/monitor.js";
import { ConflictError, type AppError } from "../../../../shared/errors.js";
import { err, ok, type Result } from "../../../../shared/result.js";
import type { UserDto } from "../../../../shared/contracts/user.js";

import type { CreateUserCommand } from "../dto/create-user.dto.js";
import { User } from "../../domain/entities/user.js";
import type { UserRepository } from "../../domain/repositories/user-repository.js";
import { EmailAddress } from "../../domain/value-objects/email-address.js";

export class CreateUserService {
  constructor(
    private readonly repository: UserRepository,
    private readonly logger: Logger,
    private readonly monitor: Monitor,
  ) {}

  async execute(command: CreateUserCommand): Promise<Result<UserDto, AppError>> {
    const start = Date.now();

    const emailResult = EmailAddress.create(command.email);
    if (!emailResult.ok) {
      this.monitor.increment("user.create.validation_error");
      return emailResult;
    }

    const existing = await this.repository.findByEmail(emailResult.value.value);
    if (existing) {
      this.monitor.increment("user.create.conflict");
      return err(new ConflictError("Email already exists", { email: emailResult.value.value }));
    }

    const userResult = User.create({
      id: randomUUID(),
      email: emailResult.value,
      displayName: command.displayName,
      age: command.age,
      createdAt: new Date(),
    });

    if (!userResult.ok) {
      this.monitor.increment("user.create.validation_error");
      return userResult;
    }

    await this.repository.save(userResult.value);

    const dto: UserDto = {
      id: userResult.value.id,
      email: userResult.value.email.value,
      displayName: userResult.value.displayName,
      age: userResult.value.age,
      createdAt: userResult.value.createdAt.toISOString(),
    };

    this.monitor.increment("user.create.success");
    this.monitor.timing("user.create.latency_ms", Date.now() - start);
    this.logger.info("User created", { userId: dto.id, email: dto.email });

    return ok(dto);
  }
}

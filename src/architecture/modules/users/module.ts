import { Container, type Token } from "../../app/container.js";
import type { Logger } from "../../shared/logging/logger.js";
import type { Monitor } from "../../shared/monitoring/monitor.js";

import { CreateUserService } from "./application/services/create-user.service.js";
import type { UserRepository } from "./domain/repositories/user-repository.js";
import { InMemoryUserRepository } from "./infrastructure/repositories/in-memory-user.repository.js";
import { UsersController } from "./presentation/http/user.controller.js";

export const USER_TOKENS: {
  readonly USER_REPOSITORY: Token<UserRepository>;
  readonly CREATE_USER_SERVICE: Token<CreateUserService>;
  readonly USER_CONTROLLER: Token<UsersController>;
} = {
  USER_REPOSITORY: Symbol("USER_REPOSITORY"),
  CREATE_USER_SERVICE: Symbol("CREATE_USER_SERVICE"),
  USER_CONTROLLER: Symbol("USER_CONTROLLER"),
};

export const registerUserModule = (
  container: Container,
  deps: { logger: Logger; monitor: Monitor },
): void => {
  container.registerValue(USER_TOKENS.USER_REPOSITORY, new InMemoryUserRepository());

  container.registerFactory(
    USER_TOKENS.CREATE_USER_SERVICE,
    (resolvedContainer) =>
      new CreateUserService(
        resolvedContainer.resolve(USER_TOKENS.USER_REPOSITORY),
        deps.logger.child({ module: "users" }),
        deps.monitor,
      ),
  );

  container.registerFactory(
    USER_TOKENS.USER_CONTROLLER,
    (resolvedContainer) =>
      new UsersController(resolvedContainer.resolve(USER_TOKENS.CREATE_USER_SERVICE)),
  );
};

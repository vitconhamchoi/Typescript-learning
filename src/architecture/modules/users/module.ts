import { Container, type Token } from "../../app/container.js";
import type { Logger } from "../../shared/logging/logger.js";
import type { Monitor } from "../../shared/monitoring/monitor.js";
import {
  BaseModule,
  createToken,
  type ModuleDependencies,
} from "../../shared/base/base-module.js";

import { CreateUserService } from "./application/services/create-user.service.js";
import type { UserRepository } from "./domain/repositories/user-repository.js";
import { InMemoryUserRepository } from "./infrastructure/repositories/in-memory-user.repository.js";
import { UsersController } from "./presentation/http/user.controller.js";

export const USER_TOKENS: {
  readonly USER_REPOSITORY: Token<UserRepository>;
  readonly CREATE_USER_SERVICE: Token<CreateUserService>;
  readonly USER_CONTROLLER: Token<UsersController>;
} = {
  USER_REPOSITORY: createToken<UserRepository>("users", "USER_REPOSITORY"),
  CREATE_USER_SERVICE: createToken<CreateUserService>("users", "CREATE_USER_SERVICE"),
  USER_CONTROLLER: createToken<UsersController>("users", "USER_CONTROLLER"),
};

class UserModule extends BaseModule<typeof USER_TOKENS> {
  constructor() {
    super("users", USER_TOKENS);
  }

  protected registerBindings(container: Container, deps: ModuleDependencies): void {
    container.registerValue(USER_TOKENS.USER_REPOSITORY, new InMemoryUserRepository());

    container.registerFactory(
      USER_TOKENS.CREATE_USER_SERVICE,
      (resolvedContainer) =>
        new CreateUserService(
          resolvedContainer.resolve(USER_TOKENS.USER_REPOSITORY),
          deps.logger,
          deps.monitor,
        ),
    );

    container.registerFactory(
      USER_TOKENS.USER_CONTROLLER,
      (resolvedContainer) =>
        new UsersController(resolvedContainer.resolve(USER_TOKENS.CREATE_USER_SERVICE)),
    );
  }
}

const userModule = new UserModule();

export const registerUserModule = (
  container: Container,
  deps: { logger: Logger; monitor: Monitor },
): void => {
  userModule.register(container, deps);
};

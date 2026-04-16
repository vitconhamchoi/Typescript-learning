import { Container } from "./container.js";
import { USER_TOKENS, registerUserModule } from "../modules/users/module.js";
import { ConsoleLogger } from "../shared/logging/logger.js";
import { InMemoryMonitor } from "../shared/monitoring/monitor.js";
import { loadConfig } from "../shared/config.js";
import { type Result, err, ok } from "../shared/result.js";
import type { ConfigError } from "../shared/errors.js";
import type { UsersController } from "../modules/users/presentation/http/user.controller.js";

export interface ApplicationContext {
  container: Container;
  usersController: UsersController;
  monitor: InMemoryMonitor;
}

export const bootstrapApplication = (
  env: NodeJS.ProcessEnv,
): Result<ApplicationContext, ConfigError> => {
  const configResult = loadConfig(env);
  if (!configResult.ok) {
    return err(configResult.error);
  }

  const config = configResult.value;
  const logger = new ConsoleLogger({ service: "architecture-sample", env: config.NODE_ENV, logLevel: config.LOG_LEVEL });
  const monitor = new InMemoryMonitor();

  const container = new Container();
  registerUserModule(container, { logger, monitor });

  return ok({
    container,
    usersController: container.resolve(USER_TOKENS.USER_CONTROLLER),
    monitor,
  });
};

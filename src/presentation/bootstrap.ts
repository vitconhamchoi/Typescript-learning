import { Container, type Token } from "../application/shared/container.js";
import { CreateTodoService } from "../application/todos/services/create-todo.service.js";
import { CreateTodoUseCase } from "../application/todos/use-cases/create-todo.use-case.js";
import { CreateUserService } from "../application/users/services/create-user.service.js";
import { CreateUserUseCase } from "../application/users/use-cases/create-user.use-case.js";
import { type Result, err, ok } from "../domain/shared/result.js";
import type { ConfigError } from "../domain/shared/errors.js";
import type { TodoRepository } from "../domain/todos/repositories/todo-repository.js";
import type { UserRepository } from "../domain/users/repositories/user-repository.js";
import { loadConfig } from "../infrastructure/config/load-config.js";
import { ConsoleLogger } from "../infrastructure/config/console-logger.js";
import { InMemoryMonitor } from "../infrastructure/config/in-memory-monitor.js";
import { InMemoryDatabase } from "../infrastructure/database/in-memory-database.js";
import { InMemoryTodoRepository } from "../infrastructure/repositories/in-memory-todo.repository.js";
import { InMemoryUserRepository } from "../infrastructure/repositories/in-memory-user.repository.js";
import { LoginScreen } from "./screens/login/login.screen.js";
import { TodoListScreen } from "./screens/todo-list/todo-list.screen.js";
import { UserProfileScreen } from "./screens/user-profile/user-profile.screen.js";

const TOKENS: {
  readonly USER_PROFILE_SCREEN: Token<UserProfileScreen>;
  readonly TODO_LIST_SCREEN: Token<TodoListScreen>;
  readonly LOGIN_SCREEN: Token<LoginScreen>;
} = {
  USER_PROFILE_SCREEN: Symbol("USER_PROFILE_SCREEN"),
  TODO_LIST_SCREEN: Symbol("TODO_LIST_SCREEN"),
  LOGIN_SCREEN: Symbol("LOGIN_SCREEN"),
};

export interface ApplicationContext {
  container: Container;
  userProfileScreen: UserProfileScreen;
  todoListScreen: TodoListScreen;
  loginScreen: LoginScreen;
  monitor: InMemoryMonitor;
}

export const bootstrapApplication = (
  env: NodeJS.ProcessEnv,
): Result<ApplicationContext, ConfigError> => {
  const configResult = loadConfig(env);
  if (!configResult.ok) {
    return err(configResult.error);
  }

  const logger = new ConsoleLogger({ service: "architecture-sample", env: configResult.value.NODE_ENV });
  const monitor = new InMemoryMonitor();
  const db = new InMemoryDatabase();
  const userRepository: UserRepository = new InMemoryUserRepository(db);
  const todoRepository: TodoRepository = new InMemoryTodoRepository(db);

  const container = new Container();

  container.registerFactory(
    TOKENS.USER_PROFILE_SCREEN,
    () => {
      const service = new CreateUserService(
        userRepository,
        logger.child({ module: "users" }),
        monitor,
      );
      return new UserProfileScreen(new CreateUserUseCase(service));
    },
  );

  container.registerFactory(
    TOKENS.TODO_LIST_SCREEN,
    () => {
      const service = new CreateTodoService(
        todoRepository,
        logger.child({ module: "todos" }),
        monitor,
      );
      return new TodoListScreen(new CreateTodoUseCase(service));
    },
  );

  container.registerFactory(TOKENS.LOGIN_SCREEN, () => new LoginScreen());

  return ok({
    container,
    userProfileScreen: container.resolve(TOKENS.USER_PROFILE_SCREEN),
    todoListScreen: container.resolve(TOKENS.TODO_LIST_SCREEN),
    loginScreen: container.resolve(TOKENS.LOGIN_SCREEN),
    monitor,
  });
};

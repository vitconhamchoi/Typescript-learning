import { type Container, type Token } from "../../app/container.js";
import type { Logger } from "../logging/logger.js";
import type { Monitor } from "../monitoring/monitor.js";

export interface ModuleDependencies {
  logger: Logger;
  monitor: Monitor;
}

export const createToken = <T>(moduleName: string, tokenName: string): Token<T> =>
  Symbol(`${moduleName}.${tokenName}`);

export abstract class BaseModule<TTokens extends Record<string, Token<unknown>>> {
  protected constructor(
    private readonly moduleName: string,
    public readonly tokens: TTokens,
  ) {}

  register(container: Container, deps: ModuleDependencies): void {
    this.registerBindings(container, {
      ...deps,
      logger: deps.logger.child({ module: this.moduleName }),
    });
  }

  protected abstract registerBindings(container: Container, deps: ModuleDependencies): void;
}

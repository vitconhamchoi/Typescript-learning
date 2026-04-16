import assert from "node:assert/strict";
import test from "node:test";

import { Container, type Token } from "../../app/container.js";
import { BaseModule, createToken, type ModuleDependencies } from "./base-module.js";
import type { Logger } from "../logging/logger.js";

const TEST_TOKENS: {
  readonly LOGGER: Token<Logger>;
} = {
  LOGGER: createToken<Logger>("test", "LOGGER"),
};

class TestModule extends BaseModule<typeof TEST_TOKENS> {
  constructor() {
    super("test", TEST_TOKENS);
  }

  protected registerBindings(container: Container, deps: ModuleDependencies): void {
    container.registerValue(TEST_TOKENS.LOGGER, deps.logger);
  }
}

test("BaseModule should scope logger and keep DI registration", () => {
  const childLogger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => childLogger,
  };

  let childContext: Record<string, unknown> | undefined;
  const rootLogger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: (context) => {
      childContext = context;
      return childLogger;
    },
  };

  const container = new Container();
  new TestModule().register(container, {
    logger: rootLogger,
    monitor: {
      increment: () => undefined,
      timing: () => undefined,
      snapshot: () => ({ counters: {}, timings: {} }),
    },
  });

  assert.deepEqual(childContext, { module: "test" });
  assert.equal(container.resolve(TEST_TOKENS.LOGGER), childLogger);
});

import assert from "node:assert/strict";
import test from "node:test";

import { Container } from "./container.js";

test("Container.resolve should throw for missing token", () => {
  const container = new Container();
  const token = Symbol("MISSING");

  assert.throws(() => container.resolve(token), /Missing dependency/);
});

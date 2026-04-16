import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "./config.js";

test("loadConfig should parse valid config", () => {
  const result = loadConfig({
    NODE_ENV: "production",
    PORT: "8080",
    LOG_LEVEL: "warn",
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.NODE_ENV, "production");
    assert.equal(result.value.PORT, 8080);
    assert.equal(result.value.LOG_LEVEL, "warn");
  }
});

test("loadConfig should return typed error for invalid config", () => {
  const result = loadConfig({
    NODE_ENV: "staging",
    PORT: "not-a-number",
    LOG_LEVEL: "invalid",
  } as unknown as NodeJS.ProcessEnv);

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "CONFIG_ERROR");
  }
});

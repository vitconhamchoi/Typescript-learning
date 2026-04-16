import assert from "node:assert/strict";
import test from "node:test";

import { EmailAddress } from "./email-address.js";

test("EmailAddress.create should normalize valid email", () => {
  const result = EmailAddress.create("  USER@Example.com ");

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.value, "user@example.com");
  }
});

test("EmailAddress.create should reject invalid email", () => {
  const result = EmailAddress.create("invalid-email");

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "VALIDATION_ERROR");
  }
});

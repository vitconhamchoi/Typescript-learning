import assert from "node:assert/strict";
import test from "node:test";

import { bootstrapApplication } from "../../../../app/bootstrap.js";

test("UsersController integration should return standardized errors", async () => {
  const app = bootstrapApplication({ NODE_ENV: "test", PORT: "3000", LOG_LEVEL: "debug" });
  assert.equal(app.ok, true);
  if (!app.ok) {
    return;
  }

  const invalid = await app.value.usersController.create(
    { email: "invalid-email", displayName: "ab", age: 5 },
    { requestId: "integration-req-1" },
  );

  assert.equal(invalid.success, false);
  if (!invalid.success) {
    assert.equal(invalid.error.code, "VALIDATION_ERROR");
    assert.equal(invalid.meta.requestId, "integration-req-1");
  }
});

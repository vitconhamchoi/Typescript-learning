import assert from "node:assert/strict";
import test from "node:test";

import { bootstrapApplication } from "../../bootstrap.js";

test("TodoListScreen integration should create todo for valid request", async () => {
  const app = bootstrapApplication({ NODE_ENV: "test", PORT: "3000", LOG_LEVEL: "debug" });
  assert.equal(app.ok, true);
  if (!app.ok) {
    return;
  }

  const created = await app.value.todoListScreen.create(
    { userId: "user-1", title: "Ship architecture refactor" },
    "integration-todo-1",
  );

  assert.equal(created.success, true);
  if (created.success) {
    assert.equal(created.data.userId, "user-1");
    assert.equal(created.data.title, "Ship architecture refactor");
  }
});

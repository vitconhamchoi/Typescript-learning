import { bootstrapApplication } from "./bootstrap.js";

const app = bootstrapApplication(process.env);

if (!app.ok) {
  console.error("Failed to bootstrap application", app.error);
  process.exit(1);
}

const userResponse = await app.value.userProfileScreen.create(
  {
    email: "alice@example.com",
    displayName: "Alice",
    age: 27,
  },
  "req_user_001",
);

const todoResponse = await app.value.todoListScreen.create(
  {
    userId: userResponse.success ? userResponse.data.id : "unknown",
    title: "Review layered architecture",
  },
  "req_todo_001",
);

console.log("Create user response:", JSON.stringify(userResponse, null, 2));
console.log("Create todo response:", JSON.stringify(todoResponse, null, 2));
console.log("Monitoring snapshot:", app.value.monitor.snapshot());

import { bootstrapApplication } from "./app/bootstrap.js";

const app = bootstrapApplication(process.env);

if (!app.ok) {
  console.error("Failed to bootstrap application", app.error);
  process.exit(1);
}

const requestId = "req_arch_001";

const success = await app.value.usersController.create(
  {
    email: "alice@example.com",
    displayName: "Alice",
    age: 27,
  },
  { requestId },
);

const duplicate = await app.value.usersController.create(
  {
    email: "alice@example.com",
    displayName: "Alice Clone",
    age: 27,
  },
  { requestId: "req_arch_002" },
);

console.log("Create user response:", JSON.stringify(success, null, 2));
console.log("Duplicate response:", JSON.stringify(duplicate, null, 2));
console.log("Monitoring snapshot:", app.value.monitor.snapshot());

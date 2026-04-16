import { AppError } from "./app-error.js";

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super("VALIDATION_ERROR", message, details, 422);
    this.name = "ValidationError";
  }
}

import { ValidationError } from "../../shared/errors.js";
import { err, ok, type Result } from "../../shared/result.js";

export class TodoTitle {
  private constructor(public readonly value: string) {}

  static create(raw: string): Result<TodoTitle, ValidationError> {
    const normalized = raw.trim();

    if (normalized.length < 3) {
      return err(new ValidationError("Todo title must be at least 3 characters"));
    }

    if (normalized.length > 120) {
      return err(new ValidationError("Todo title must be at most 120 characters"));
    }

    return ok(new TodoTitle(normalized));
  }
}

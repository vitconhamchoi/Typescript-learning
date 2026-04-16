import { ValidationError } from "../../../../shared/errors.js";
import { err, ok, type Result } from "../../../../shared/result.js";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class EmailAddress {
  private constructor(public readonly value: string) {}

  static create(raw: string): Result<EmailAddress, ValidationError> {
    const normalized = raw.trim().toLowerCase();

    if (!EMAIL_REGEX.test(normalized)) {
      return err(new ValidationError("Invalid email format", { email: raw }));
    }

    return ok(new EmailAddress(normalized));
  }
}

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "CONFLICT"
  | "CONFIG_ERROR"
  | "INTERNAL_ERROR";

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
    public readonly statusCode: number = 400,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super("CONFLICT", message, details, 409);
    this.name = "ConflictError";
  }
}

export class ConfigError extends AppError {
  constructor(message: string, details?: unknown) {
    super("CONFIG_ERROR", message, details, 500);
    this.name = "ConfigError";
  }
}

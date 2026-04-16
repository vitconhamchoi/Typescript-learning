export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  child(context: Record<string, unknown>): Logger;
}

type LogLevel = "debug" | "info" | "warn" | "error";

export class ConsoleLogger implements Logger {
  constructor(private readonly context: Record<string, unknown> = {}) {}

  child(context: Record<string, unknown>): Logger {
    return new ConsoleLogger({ ...this.context, ...context });
  }

  debug(message: string, context: Record<string, unknown> = {}): void {
    this.log("debug", message, context);
  }

  info(message: string, context: Record<string, unknown> = {}): void {
    this.log("info", message, context);
  }

  warn(message: string, context: Record<string, unknown> = {}): void {
    this.log("warn", message, context);
  }

  error(message: string, context: Record<string, unknown> = {}): void {
    this.log("error", message, context);
  }

  private log(level: LogLevel, message: string, extra: Record<string, unknown>): void {
    const payload = {
      level,
      message,
      timestamp: new Date().toISOString(),
      ...this.context,
      ...extra,
    };

    console.log(JSON.stringify(payload));
  }
}

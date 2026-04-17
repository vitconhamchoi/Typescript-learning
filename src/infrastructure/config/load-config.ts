import { z } from "zod";

import { ConfigError } from "../../domain/shared/errors.js";
import { err, ok, type Result } from "../../domain/shared/result.js";

const ConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export const loadConfig = (
  env: NodeJS.ProcessEnv,
): Result<AppConfig, ConfigError> => {
  const parsed = ConfigSchema.safeParse(env);

  if (!parsed.success) {
    return err(new ConfigError("Invalid environment configuration", parsed.error.flatten()));
  }

  return ok(parsed.data);
};

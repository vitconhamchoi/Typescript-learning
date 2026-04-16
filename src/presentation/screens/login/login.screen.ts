import { z } from "zod";

import { ValidationError } from "../../../domain/shared/errors.js";
import { errorResponse, successResponse, type ApiResponse } from "../../../application/shared/contracts/api.js";

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

export interface LoginResponse {
  token: string;
  email: string;
}

export class LoginScreen {
  submit(payload: unknown, requestId: string): ApiResponse<LoginResponse> {
    const parsed = LoginSchema.safeParse(payload);
    if (!parsed.success) {
      return errorResponse(new ValidationError("Invalid login payload", parsed.error.flatten()), requestId);
    }

    return successResponse(
      {
        token: `token_${parsed.data.email}`,
        email: parsed.data.email,
      },
      requestId,
    );
  }
}

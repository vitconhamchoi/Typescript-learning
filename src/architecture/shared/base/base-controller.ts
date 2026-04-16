import { ValidationError, type AppError } from "../errors.js";
import { errorResponse, successResponse, type ApiResponse } from "../contracts/api.js";
import type { Result } from "../result.js";

export interface RequestContext {
  requestId: string;
}

export abstract class BaseController {
  protected success<T>(data: T, context: RequestContext): ApiResponse<T> {
    return successResponse(data, context.requestId);
  }

  protected failure(error: AppError, context: RequestContext): ApiResponse<never> {
    return errorResponse(error, context.requestId);
  }

  protected validationFailure(
    message: string,
    details: unknown,
    context: RequestContext,
  ): ApiResponse<never> {
    return this.failure(new ValidationError(message, details), context);
  }

  protected toResponse<T>(result: Result<T, AppError>, context: RequestContext): ApiResponse<T> {
    if (!result.ok) {
      return this.failure(result.error, context);
    }

    return this.success(result.value, context);
  }
}

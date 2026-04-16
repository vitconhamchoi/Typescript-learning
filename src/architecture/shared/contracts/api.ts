import { AppError } from "../errors.js";

export interface ApiMeta {
  requestId: string;
  timestamp: string;
}

export interface ApiErrorPayload {
  code: string;
  message: string;
  details?: unknown;
}

export type ApiResponse<T> =
  | { success: true; data: T; meta: ApiMeta }
  | { success: false; error: ApiErrorPayload; meta: ApiMeta };

export const successResponse = <T>(data: T, requestId: string): ApiResponse<T> => ({
  success: true,
  data,
  meta: {
    requestId,
    timestamp: new Date().toISOString(),
  },
});

export const errorResponse = (error: AppError, requestId: string): ApiResponse<never> => ({
  success: false,
  error: {
    code: error.code,
    message: error.message,
    details: error.details,
  },
  meta: {
    requestId,
    timestamp: new Date().toISOString(),
  },
});

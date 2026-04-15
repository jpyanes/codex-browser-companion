import type { ActivityLogEntry, AppError, LogLevel } from "./types";

export function nowIso(): string {
  return new Date().toISOString();
}

export function createActivityLogEntry(
  level: LogLevel,
  message: string,
  options: { tabId?: number | null | undefined; details?: string | undefined } = {},
): ActivityLogEntry {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `log_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    tabId: options.tabId ?? null,
    level,
    message,
    details: options.details,
    timestamp: nowIso(),
  };
}

export function normalizeError(
  error: unknown,
  code = "UNKNOWN_ERROR",
  options: { tabId?: number | undefined; recoverable?: boolean } = {},
): AppError {
  if (typeof error === "object" && error !== null) {
    const maybeError = error as { code?: unknown; message?: unknown; details?: unknown };
    const message =
      typeof maybeError.message === "string"
        ? maybeError.message
        : "An unexpected error occurred.";
    const detailValue =
      typeof maybeError.details === "string"
        ? maybeError.details
        : error instanceof Error
          ? error.stack ?? error.message
          : undefined;

    return {
      code: typeof maybeError.code === "string" ? maybeError.code : code,
      message,
      details: detailValue,
      recoverable: options.recoverable ?? true,
      tabId: options.tabId,
      occurredAt: nowIso(),
    };
  }

  return {
    code,
    message: typeof error === "string" ? error : "An unexpected error occurred.",
    details: undefined,
    recoverable: options.recoverable ?? true,
    tabId: options.tabId,
    occurredAt: nowIso(),
  };
}

export function errorDetails(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

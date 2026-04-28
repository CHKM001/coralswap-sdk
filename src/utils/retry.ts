import { Logger } from "@/types/common";
import { DEFAULTS } from "@/config";

/**
 * Options for the retry policy.
 */
export interface RetryOptions {
  maxRetries: number;
  retryDelayMs: number;
  maxRetryDelayMs: number;
}

export type RetryConfig = RetryOptions;

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: DEFAULTS.maxRetries,
  retryDelayMs: DEFAULTS.retryDelayMs,
  maxRetryDelayMs: 10000,
};

/**
 * Determine if an error is retryable (429, 503, or network timeout)
 */
export function isRetryable(err: any): boolean {
  const status = err?.response?.status;
  return (
    status === 429 ||
    status === 503 ||
    err?.code === "ECONNABORTED" ||
    err?.code === "ETIMEDOUT" ||
    err?.message?.includes("timeout")
  );
}

/**
 * Helper to sleep for a given duration.
 */
export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Helper to execute an async function with exponential backoff retry.
 *
 * @param fn - The async function to execute
 * @param options - Retry configuration
 * @param logger - Optional logger for instrumentation
 * @param label - A label for logging purposes
 * @returns The result of the function
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
  logger?: Logger,
  label: string = "RPC",
): Promise<T> {
  const { maxRetries, retryDelayMs, maxRetryDelayMs } = options;
  let lastError: any;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;

      if (!isRetryable(err) || attempt === maxRetries) {
        throw err;
      }

      // Exponential backoff with jitter
      const backoff = Math.min(
        maxRetryDelayMs,
        retryDelayMs * Math.pow(2, attempt),
      );
      const jitter = backoff * 0.15 * (Math.random() * 2 - 1);
      const delay = Math.max(0, backoff + jitter);

      logger?.debug(`${label}: retrying after ${Math.round(delay)}ms`, {
        attempt: attempt + 1,
        maxRetries,
        error: err.message,
      });

      await sleep(delay);
    }
  }

  throw lastError;
}

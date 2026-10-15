import type { ApiErrorCode } from "#shared/apiErrors.ts";

/**
 * A refusal that carries its HTTP answer, so the asset services can stay
 * free of Fastify and the routes can translate any of them the same way.
 *
 * `code` is a stable machine-readable string the client switches on. It never
 * carries internal detail: an SSRF refusal must not tell the caller whether a
 * host was private, unreachable or slow.
 */
export class AssetError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  /** Seconds, sent as `Retry-After`. The client retries 503s that carry it. */
  readonly retryAfter: number | undefined;
  /**
   * Set when the request body was not (fully) read. The answer then closes
   * the connection, so Node does not read and discard the rest of the body
   * just to keep the socket alive.
   */
  readonly closeConnection: boolean;

  constructor(status: number, code: ApiErrorCode, opts: { retryAfter?: number; closeConnection?: boolean; cause?: unknown } = {}) {
    super(code, { cause: opts.cause });
    this.name = "AssetError";
    this.status = status;
    this.code = code;
    this.retryAfter = opts.retryAfter;
    this.closeConnection = opts.closeConnection ?? false;
  }
}

export function isAssetError(err: unknown): err is AssetError {
  return err instanceof AssetError;
}

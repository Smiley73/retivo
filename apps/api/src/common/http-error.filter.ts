/**
 * Global exception filter that normalizes every error into the project's
 * standard envelope):
 *
 *   { error: { code, message, details?, traceId } }
 *
 * Behavior:
 * - HttpExceptions: honor their status + optional `code`/`details`, falling
 *   back to a stable default code for the status class.
 * - Unknown errors: surface as 500 `INTERNAL_ERROR` and log with stack.
 *   We deliberately do not leak the underlying message to clients.
 * - Correlation: echo an incoming `x-correlation-id` header as `traceId`,
 *   or mint one. This is the hook clients use to link logs/traces to a
 *   specific failure.
 */
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message = 'An unexpected error occurred';
    let details: unknown = undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const resp = exception.getResponse();
      if (typeof resp === 'string') {
        message = resp;
      } else if (resp && typeof resp === 'object') {
        // Callers may attach a machine-readable `code` and optional `details`.
        // Anything else on the response object is ignored to keep the shape stable.
        const r = resp as Record<string, unknown>;
        message = (r.message as string) ?? message;
        code = (r.code as string) ?? this.defaultCode(status);
        details = r.details;
      }
      code = code === 'INTERNAL_ERROR' ? this.defaultCode(status) : code;
    } else if (exception instanceof Error) {
      // Express middleware errors (body-parser PayloadTooLargeError, etc.)
      // expose a numeric `status`/`statusCode`. Honor it so 413/415 etc. surface
      // as their proper code instead of being flattened to 500.
      const expressErr = exception as Error & { status?: number; statusCode?: number };
      const expressStatus = expressErr.status ?? expressErr.statusCode;
      if (typeof expressStatus === 'number' && expressStatus >= 400 && expressStatus < 600) {
        status = expressStatus;
        code = this.defaultCode(status);
        message = exception.message;
      } else {
        // Unknown error class: record server-side, but never reveal internals.
        this.logger.error(exception.message, exception.stack);
      }
    }

    const traceId = (req.headers['x-correlation-id'] as string) ?? randomUUID();

    res.status(status).json({
      error: { code, message, details, traceId },
    });
  }

  private defaultCode(status: number): string {
    switch (status) {
      case 400:
        return 'BAD_REQUEST';
      case 401:
        return 'UNAUTHENTICATED';
      case 403:
        return 'FORBIDDEN';
      case 404:
        return 'RESOURCE_NOT_FOUND';
      case 409:
        return 'CONFLICT';
      case 413:
        return 'PAYLOAD_TOO_LARGE';
      case 415:
        return 'UNSUPPORTED_MEDIA_TYPE';
      case 422:
        return 'UNPROCESSABLE_ENTITY';
      case 429:
        return 'RATE_LIMITED';
      case 503:
        return 'DEPENDENCY_UNAVAILABLE';
      default:
        return 'INTERNAL_ERROR';
    }
  }
}

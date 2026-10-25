// Global exception filter normalizing every error into `{ error: { code, message, details?, traceId } }`; unknown errors become 500
// INTERNAL_ERROR with the message withheld from the client.
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { ErrorEnvelope } from '@retirement/contracts';
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
        // Callers may attach a machine-readable `code` and `details`; anything else on the response object is ignored
        // to keep the shape stable.
        const r = resp as Record<string, unknown>;
        message = (r.message as string) ?? message;
        code = (r.code as string) ?? this.defaultCode(status);
        details = r.details;
      }
      code = code === 'INTERNAL_ERROR' ? this.defaultCode(status) : code;
    } else if (exception instanceof Error) {
      // Express middleware errors (body-parser PayloadTooLargeError) expose a numeric status; honor it so 413 and 415
      // are not flattened to 500.
      const expressErr = exception as Error & { status?: number; statusCode?: number };
      const expressStatus = expressErr.status ?? expressErr.statusCode;
      if (typeof expressStatus === 'number' && expressStatus >= 400 && expressStatus < 600) {
        status = expressStatus;
        code = this.defaultCode(status);
        message = exception.message;
      } else {
        // Unknown error class: log server-side, never reveal internals.
        this.logger.error(exception.message, exception.stack);
      }
    }

    const traceId = (req.headers['x-correlation-id'] as string) ?? randomUUID();

    const body: ErrorEnvelope = { error: { code, message, details, traceId } };
    res.status(status).json(body);
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

import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync, type ValidationError } from 'class-validator';

type DtoClass<T extends object> = new () => T;

function flatten(errors: ValidationError[], prefix = ''): string[] {
  return errors.flatMap((e) => {
    const path = prefix ? `${prefix}.${e.property}` : e.property;
    const own = Object.keys(e.constraints ?? {}).map((c) => `${path}:${c}`);
    return [...own, ...flatten(e.children ?? [], path)];
  });
}

/** Validates a body as the global ValidationPipe does (transform, whitelist, forbidNonWhitelisted) and returns each violation as `<property path>:<constraint>`; empty means accepted. */
export function dtoViolations<T extends object>(dto: DtoClass<T>, body: unknown): string[] {
  const instance = plainToInstance(dto, body) as object;
  return flatten(validateSync(instance, { whitelist: true, forbidNonWhitelisted: true }));
}

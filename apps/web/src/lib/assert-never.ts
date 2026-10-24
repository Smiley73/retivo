/** For a `switch` `default` arm: a compile error when a union member lacks an arm, a throw for an off-type value. */
export function assertNever(x: never): never {
  throw new Error(`Unexpected value: ${String(x)}`);
}

/**
 * Exhaustiveness helper. Place in the `default` arm of a `switch` over a
 * finite union so the compiler errors if a new member is added without a
 * matching arm; throws at runtime if an off-type value still reaches it.
 */
export function assertNever(x: never): never {
  throw new Error(`Unexpected value: ${String(x)}`);
}

/** A manual clock for the pairing store and relay. */
export class Clock {
  constructor(private time = Date.UTC(2026, 0, 1)) {}
  readonly now = (): number => this.time;
  advance(ms: number): void {
    this.time += ms;
  }
}

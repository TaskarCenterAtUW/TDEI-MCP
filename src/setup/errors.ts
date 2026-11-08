/** A mistake in how the command was invoked; the message says exactly what to change. */
export class SetupUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SetupUsageError";
  }
}

/** Domain invariant failure. This is not an HTTP error and not an ORM error. */
export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainError";
  }
}

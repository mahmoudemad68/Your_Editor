/** Private process protocol carries only this bounded code, never raw media/adapter errors. */
export class MediaEditInputError extends Error {
  constructor() {
    super("Unsupported media editing input.");
    this.name = "MediaEditInputError";
  }
}

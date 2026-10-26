export class AccessDeniedError extends Error {
  readonly code = 'access-denied';
  /**
   * The message is the same for "undeclared type", "unbound Space" and "no such object", so the answer
   * is not an existence oracle (research R-10). Details go to the host's access:denied event instead.
   */
  constructor(
    readonly module: string,
    readonly what: string,
  ) {
    super(`module "${module}" may not ${what}`);
    this.name = 'AccessDeniedError';
  }
}

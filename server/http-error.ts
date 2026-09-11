export class HttpError extends Error {
  constructor(readonly status: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HttpError";
  }
}

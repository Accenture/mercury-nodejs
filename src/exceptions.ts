/**
 * AppException mirrors the Java/Rust engines' AppException: an intentional
 * application error carrying an HTTP-style status code and a message. Thrown
 * from a function handler, it becomes the portable error contract on the
 * wire: envelope status (>= 400) + body (the error message).
 */
export class AppException extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'AppException';
    this.status = Math.trunc(status);
  }
}

/**
 * The payload used the classic compact wire format (single-character map
 * keys). This implementation speaks the language-neutral standard format
 * only; engines default to standard for Event over HTTP.
 */
export class CompactFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompactFormatError';
  }
}

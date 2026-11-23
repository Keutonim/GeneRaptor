export class ValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
    this.statusCode = status;
    this.name = 'ValidationError';
  }
}

export const notFound = (message) => new ValidationError(message, 404);

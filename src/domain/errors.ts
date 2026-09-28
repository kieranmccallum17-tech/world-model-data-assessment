export class AppError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code: string
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string) => new AppError(400, message, 'BAD_REQUEST');
export const unauthorized = () => new AppError(401, 'Authentication required', 'UNAUTHORIZED');
export const forbidden = () => new AppError(403, 'You are not allowed to perform this action', 'FORBIDDEN');
export const notFound = (message = 'Resource not found') => new AppError(404, message, 'NOT_FOUND');
import { NextFunction, Request, Response } from 'express';
import { forbidden, unauthorized } from '../domain/errors';
import { AuthUser } from '../domain/types';
import { AuthService } from './authService';

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function authentication(authService: AuthService) {
  return async (request: Request, _response: Response, next: NextFunction) => {
    const header = request.header('authorization');
    if (!header?.startsWith('Bearer ')) return next(unauthorized());
    try {
      request.user = await authService.authenticate(header.slice(7));
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function requireRole(role: AuthUser['role']) {
  return (request: Request, _response: Response, next: NextFunction) => {
    if (request.user?.role !== role) return next(forbidden());
    next();
  };
}
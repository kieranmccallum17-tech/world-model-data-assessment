import '../testSetup';
import express from 'express';
import request from 'supertest';
import { equal } from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AuthService } from './authService';
import { authentication, requireRole } from './middleware';
import { AppError } from '../domain/errors';
import { AuthUser } from '../domain/types';

const user: AuthUser = {
  id: 'user-1', email: 'alice@example.test', displayName: 'Alice', role: 'user'
};

function createProtectedApp(authenticate: (token: string) => Promise<AuthUser>) {
  const app = express();
  app.get('/supervisor', authentication({ authenticate } as unknown as AuthService), requireRole('supervisor'),
    (_request, response) => response.json({ ok: true }));
  app.use((error: AppError, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status(error.status).json({ error: error.message });
  });
  return app;
}

describe('server-side authentication and role enforcement', () => {
  it('rejects missing credentials', async () => {
    const app = createProtectedApp(async () => user);
    const response = await request(app).get('/supervisor');
    equal(response.status, 401);
  });

  it('rejects expired or invalid credentials', async () => {
    const app = createProtectedApp(async () => {
      throw new AppError(401, 'Authentication required', 'UNAUTHORIZED');
    });
    const response = await request(app).get('/supervisor').set('Authorization', 'Bearer expired-token');
    equal(response.status, 401);
  });

  it('rejects authenticated users from supervisor-only actions', async () => {
    const app = createProtectedApp(async () => user);
    const response = await request(app).get('/supervisor').set('Authorization', 'Bearer valid-user-token');
    equal(response.status, 403);
  });
});
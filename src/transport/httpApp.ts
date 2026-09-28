import express, { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { createClient } from 'redis';
import { z } from 'zod';
import { AuthService } from '../auth/authService';
import { authentication, requireRole } from '../auth/middleware';
import { AppError, badRequest, forbidden, notFound } from '../domain/errors';
import { AuthUser, ModerationMode } from '../domain/types';
import { ChatRepository } from '../persistence/chatRepository';
import { MessageService } from '../messaging/messageService';
import { activeSupervisorSessions } from './supervisorPresence';

const loginSchema = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(200) }).strict();
const conversationSchema = z.object({ recipientId: z.string().uuid() }).strict();
const reviewSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('approve') }).strict(),
  z.object({ action: z.literal('block') }).strict(),
  z.object({ action: z.literal('redact'), content: z.string().trim().min(1).max(4000) }).strict()
]);
const modeSchema = z.object({ mode: z.enum(['human', 'automated']) }).strict();

const asyncRoute = (handler: (request: Request, response: Response) => Promise<unknown>) =>
  (request: Request, response: Response, next: NextFunction) => {
    void handler(request, response).catch(next);
  };

function currentUser(request: Request): AuthUser {
  if (!request.user) throw new AppError(401, 'Authentication required', 'UNAUTHORIZED');
  return request.user;
}

export function createHttpApp(
  authService: AuthService,
  repository: ChatRepository,
  messages: MessageService,
  redis: ReturnType<typeof createClient>
) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  const sharedStore = (prefix: string) => new RedisStore({
    prefix,
    sendCommand: (...args: string[]) => redis.sendCommand(args)
  });
  app.use('/api', rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: (request) => request.path === '/auth/login',
    store: sharedStore('api-rate:')
  }));
  app.use(express.json({ limit: '16kb', strict: true }));

  app.get('/health', asyncRoute(async (_request, response) => {
    await redis.ping();
    await repository.getSupervisionState();
    response.json({ status: 'ok' });
  }));

  app.post('/api/auth/login', rateLimit({
    windowMs: 15 * 60_000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    store: sharedStore('login-rate:')
  }), asyncRoute(async (request, response) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Invalid login payload');
    response.json(await authService.login(parsed.data.email, parsed.data.password));
  }));

  app.use('/api', authentication(authService));
  app.get('/api/me', (request, response) => response.json({ user: currentUser(request) }));

  app.get('/api/conversations', asyncRoute(async (request, response) => {
    response.json({ conversations: await repository.listConversations(currentUser(request)) });
  }));

  app.post('/api/conversations', asyncRoute(async (request, response) => {
    const user = currentUser(request);
    const parsed = conversationSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Invalid conversation payload');
    if (parsed.data.recipientId === user.id) throw badRequest('A conversation requires another user');
    const recipient = await repository.findUserById(parsed.data.recipientId);
    if (!recipient) throw notFound('Recipient not found');
    if (recipient.role !== 'user') throw badRequest('Conversations can only be started with another user');
    response.status(201).json({
      conversation: await repository.createConversation(user.id, parsed.data.recipientId)
    });
  }));

  app.get('/api/conversations/:id/messages', asyncRoute(async (request, response) => {
    const user = currentUser(request);
    const id = z.string().uuid().safeParse(request.params.id);
    const limit = z.coerce.number().int().min(1).max(100).default(50).safeParse(request.query.limit);
    if (!id.success || !limit.success) throw badRequest('Invalid conversation id or page size');
    if (user.role !== 'supervisor' && !(await repository.isMember(id.data, user.id))) {
      throw notFound('Conversation not found');
    }
    const history = await repository.getMessages(id.data, limit.data);
    response.json({
      messages: user.role === 'supervisor'
        ? history
        : history.map((message) => message.status === 'pending' ? { ...message, content: '' } : message)
    });
  }));

  app.get('/api/supervisor/state', requireRole('supervisor'), asyncRoute(async (_request, response) => {
    response.json({ state: await repository.getSupervisionState() });
  }));

  app.put('/api/supervisor/state', requireRole('supervisor'), asyncRoute(async (request, response) => {
    const parsed = modeSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Invalid supervision mode');
    const user = currentUser(request);
    if (parsed.data.mode === 'human' && !(await activeSupervisorSessions(redis))) {
      throw badRequest('Connect a supervisor session before taking duty');
    }
    await messages.setMode(user, parsed.data.mode as ModerationMode);
    if (parsed.data.mode === 'human' && !(await activeSupervisorSessions(redis))) {
      await messages.setMode(null, 'automated');
    }
    response.json({ state: await repository.getSupervisionState() });
  }));

  app.get('/api/supervisor/pending', requireRole('supervisor'), asyncRoute(async (_request, response) => {
    response.json({ messages: await repository.getPendingMessages() });
  }));

  app.post('/api/supervisor/messages/:id/review', requireRole('supervisor'), asyncRoute(async (request, response) => {
    const id = z.string().uuid().safeParse(request.params.id);
    const decision = reviewSchema.safeParse(request.body);
    if (!id.success || !decision.success) throw badRequest('Invalid moderation decision');
    const updated = await messages.review(currentUser(request), id.data, decision.data);
    response.json({ message: updated });
  }));

  app.use((_request, _response, next) => next(notFound()));
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof AppError) {
      response.status(error.status).json({ error: error.message, code: error.code });
      return;
    }
    if (error instanceof SyntaxError && 'status' in error && error.status === 400) {
      response.status(400).json({ error: 'Malformed JSON request', code: 'BAD_REQUEST' });
      return;
    }
    console.error('HTTP request failed', error);
    response.status(500).json({ error: 'Request could not be completed', code: 'INTERNAL_ERROR' });
  });
  return app;
}
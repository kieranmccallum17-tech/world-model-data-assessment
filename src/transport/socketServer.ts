import { Server } from 'socket.io';
import { createClient } from 'redis';
import { createAdapter } from '@socket.io/redis-adapter';
import { z } from 'zod';
import { unauthorized, forbidden, AppError } from '../domain/errors';
import { AuthService } from '../auth/authService';
import { ChatRepository } from '../persistence/chatRepository';
import { MessageService } from '../messaging/messageService';
import { registerSupervisorSession, trackSupervisorSession } from './supervisorPresence';

const joinSchema = z.object({ conversationId: z.string().uuid() }).strict();
const sendSchema = z.object({
  conversationId: z.string().uuid(),
  content: z.string().trim().min(1).max(4000)
}).strict();

type Ack = (result: Record<string, unknown>) => void;

function reply(ack: unknown, value: Record<string, unknown>): void {
  if (typeof ack === 'function') (ack as Ack)(value);
}

function errorResponse(error: unknown): Record<string, unknown> {
  if (error instanceof AppError) return { error: error.message, code: error.code };
  console.error('Socket action failed', error);
  return { error: 'Request could not be completed', code: 'INTERNAL_ERROR' };
}

async function enforceSocketRateLimit(
  redis: ReturnType<typeof createClient>,
  userId: string,
  bucket: string,
  limit: number
): Promise<void> {
  const window = Math.floor(Date.now() / 60_000);
  const key = `socket-rate:${userId}:${bucket}:${window}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 60);
  if (count > limit) throw new AppError(429, 'Socket rate limit exceeded', 'RATE_LIMITED');
}

export async function createSocketServer(
  httpServer: import('node:http').Server,
  redis: ReturnType<typeof createClient>,
  authService: AuthService,
  repository: ChatRepository,
  messages: MessageService
): Promise<{ io: Server; close: () => Promise<void> }> {
  const io = new Server(httpServer, { maxHttpBufferSize: 16 * 1024 });
  const pubClient = redis.duplicate();
  const subClient = redis.duplicate();
  await Promise.all([pubClient.connect(), subClient.connect()]);
  io.adapter(createAdapter(pubClient, subClient));

  io.use(async (socket, next) => {
    const connectionWindow = Math.floor(Date.now() / 60_000);
    const connectionKey = `socket-connect:${socket.handshake.address}:${connectionWindow}`;
    try {
      const attempts = await redis.incr(connectionKey);
      if (attempts === 1) await redis.expire(connectionKey, 60);
      if (attempts > 60) return next(new AppError(429, 'Connection rate limit exceeded', 'RATE_LIMITED'));
    } catch (error) {
      return next(error instanceof Error ? error : new Error('Connection rate limit unavailable'));
    }
    const token = socket.handshake.auth?.token;
    if (typeof token !== 'string' || token.length > 4096) return next(unauthorized());
    let user;
    try {
      user = await authService.authenticate(token);
    } catch {
      return next(unauthorized());
    }
    try {
      if (user.role === 'supervisor') await registerSupervisorSession(redis, user.id, socket.id);
      socket.data.user = user;
      next();
    } catch (error) {
      next(error instanceof Error ? error : new Error('Unable to register supervisor session'));
    }
  });

  io.on('connection', (socket) => {
    const initialUser = socket.data.user as import('../domain/types').AuthUser;
    if (initialUser.role === 'supervisor') {
      trackSupervisorSession(socket, initialUser, redis, repository, messages);
    }

    const getCurrentUser = async () => {
      const token = socket.handshake.auth?.token;
      if (typeof token !== 'string') throw unauthorized();
      return authService.authenticate(token);
    };

    socket.on('conversation:join', async (payload: unknown, ack?: Ack) => {
      try {
        const user = await getCurrentUser();
        await enforceSocketRateLimit(redis, user.id, 'actions', 120);
        const parsed = joinSchema.safeParse(payload);
        if (!parsed.success) throw new AppError(400, 'Invalid conversation id', 'BAD_REQUEST');
        if (user.role !== 'supervisor' && !(await repository.isMember(parsed.data.conversationId, user.id))) {
          throw forbidden();
        }
        await socket.join(`conversation:${parsed.data.conversationId}`);
        reply(ack, { ok: true });
      } catch (error) {
        reply(ack, errorResponse(error));
      }
    });

    socket.on('conversation:monitor', async (payload: unknown, ack?: Ack) => {
      try {
        const user = await getCurrentUser();
        await enforceSocketRateLimit(redis, user.id, 'actions', 120);
        if (user.role !== 'supervisor') throw forbidden();
        const parsed = joinSchema.safeParse(payload);
        if (!parsed.success) throw new AppError(400, 'Invalid conversation id', 'BAD_REQUEST');
        await socket.join(`monitor:${parsed.data.conversationId}`);
        reply(ack, { ok: true });
      } catch (error) {
        reply(ack, errorResponse(error));
      }
    });

    socket.on('conversation:leave', async (payload: unknown, ack?: Ack) => {
      try {
        const user = await getCurrentUser();
        await enforceSocketRateLimit(redis, user.id, 'actions', 120);
        const parsed = joinSchema.safeParse(payload);
        if (!parsed.success) throw new AppError(400, 'Invalid conversation id', 'BAD_REQUEST');
        await socket.leave(user.role === 'supervisor'
          ? `monitor:${parsed.data.conversationId}`
          : `conversation:${parsed.data.conversationId}`);
        reply(ack, { ok: true });
      } catch (error) {
        reply(ack, errorResponse(error));
      }
    });

    socket.on('message:send', async (payload: unknown, ack?: Ack) => {
      try {
        const user = await getCurrentUser();
        if (user.role !== 'user') throw forbidden();
        await enforceSocketRateLimit(redis, user.id, 'messages', 30);
        const parsed = sendSchema.safeParse(payload);
        if (!parsed.success) throw new AppError(400, 'Invalid message payload', 'BAD_REQUEST');

        const message = await messages.send(user, parsed.data.conversationId, parsed.data.content);
        reply(ack, {
          ok: true,
          message: { id: message.id, status: message.status, moderationReason: message.moderationReason }
        });
      } catch (error) {
        reply(ack, errorResponse(error));
      }
    });
  });

  return {
    io,
    close: async () => {
      await new Promise<void>((resolve) => io.close(() => resolve()));
      await Promise.all([pubClient.quit(), subClient.quit()]);
    }
  };
}
import { Socket } from 'socket.io';
import { createClient } from 'redis';
import { AuthUser } from '../domain/types';
import { ChatRepository } from '../persistence/chatRepository';
import { MessageService } from '../messaging/messageService';

const sessionKey = 'supervisor:sessions';
const leaseMilliseconds = 45_000;
const heartbeatMilliseconds = 15_000;

export async function activeSupervisorSessions(redis: ReturnType<typeof createClient>): Promise<number> {
  await redis.zRemRangeByScore(sessionKey, '-inf', Date.now());
  return redis.zCard(sessionKey);
}

async function handOffIfNoSupervisor(
  redis: ReturnType<typeof createClient>,
  repository: ChatRepository,
  messages: MessageService
): Promise<void> {
  if (await activeSupervisorSessions(redis) > 0) return;
  const state = await repository.getSupervisionState();
  if (state.mode === 'human') await messages.setMode(null, 'automated');
}

export function trackSupervisorSession(
  socket: Socket,
  user: AuthUser,
  redis: ReturnType<typeof createClient>,
  repository: ChatRepository,
  messages: MessageService
): void {
  const member = `${user.id}:${socket.id}`;
  const refresh = async () => {
    await redis.zAdd(sessionKey, { score: Date.now() + leaseMilliseconds, value: member });
  };
  void refresh().catch((error) => console.error('Unable to register supervisor presence', error));

  const heartbeat = setInterval(() => {
    void refresh().catch((error) => console.error('Unable to refresh supervisor presence', error));
  }, heartbeatMilliseconds);

  socket.on('disconnect', () => {
    clearInterval(heartbeat);
    void redis.zRem(sessionKey, member)
      .then(() => handOffIfNoSupervisor(redis, repository, messages))
      .catch((error) => console.error('Unable to clear supervisor presence', error));
  });
}

export function startSupervisorLeaseSweep(
  redis: ReturnType<typeof createClient>,
  repository: ChatRepository,
  messages: MessageService
): NodeJS.Timeout {
  const timer = setInterval(() => {
    void handOffIfNoSupervisor(redis, repository, messages)
      .catch((error) => console.error('Supervisor lease sweep failed', error));
  }, heartbeatMilliseconds);
  timer.unref();
  return timer;
}

export async function registerSupervisorSession(
  redis: ReturnType<typeof createClient>,
  userId: string,
  socketId: string
): Promise<void> {
  await redis.zAdd(sessionKey, {
    score: Date.now() + leaseMilliseconds,
    value: `${userId}:${socketId}`
  });
}
import { createServer } from 'node:http';
import { createClient } from 'redis';
import { AuthService } from './auth/authService';
import { config } from './config';
import { pool, initializeDatabase } from './db/pool';
import { ChatRepository } from './persistence/chatRepository';
import { MessageService } from './messaging/messageService';
import { DelegatingMessageEvents, SocketMessageEvents } from './transport/events';
import { createHttpApp } from './transport/httpApp';
import { createSocketServer } from './transport/socketServer';
import { startSupervisorLeaseSweep } from './transport/supervisorPresence';

async function start(): Promise<void> {
  const redis = createClient({ url: config.REDIS_URL });
  redis.on('error', (error) => console.error('Redis client error', error));
  await redis.connect();
  await initializeDatabase();

  const repository = new ChatRepository(pool);
  const auth = new AuthService(repository);
  const events = new DelegatingMessageEvents();
  const messageService = new MessageService(repository, events);
  const httpServer = createServer(createHttpApp(auth, repository, messageService, redis));
  const socketRuntime = await createSocketServer(
    httpServer,
    redis,
    auth,
    repository,
    messageService
  );
  events.setTarget(new SocketMessageEvents(socketRuntime.io));
  const supervisorLeaseSweep = startSupervisorLeaseSweep(redis, repository, messageService);

  httpServer.listen(config.PORT, () => {
    console.log(`Secure Chat Supervisor listening on port ${config.PORT}`);
  });

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    clearInterval(supervisorLeaseSweep);
    await socketRuntime.close();
    await Promise.all([redis.quit(), pool.end()]);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

start().catch((error) => {
  console.error('Server startup failed', error);
  process.exitCode = 1;
});
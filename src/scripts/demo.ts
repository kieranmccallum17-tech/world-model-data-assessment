import 'dotenv/config';
import { io, Socket } from 'socket.io-client';

const baseUrl = process.env.DEMO_API_URL ?? 'http://localhost:3000';

async function request<T>(path: string, token?: string, body?: unknown, method?: 'POST' | 'PUT'): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `Request failed with ${response.status}`);
  return payload;
}

async function login(email: string, password: string): Promise<string> {
  const result = await request<{ token: string }>('/api/auth/login', undefined, { email, password });
  return result.token;
}

function connect(token: string): Promise<Socket> {
  const socket = io(baseUrl, { auth: { token }, transports: ['websocket'] });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Socket connection timed out')), 8000);
    socket.once('connect', () => {
      clearTimeout(timeout);
      resolve(socket);
    });
    socket.once('connect_error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function emitAck<T>(socket: Socket, event: string, payload: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    socket.emit(event, payload, (result: T & { error?: string; ok?: boolean }) => {
      if (result.error || result.ok === false) reject(new Error(result.error ?? 'Socket action failed'));
      else resolve(result);
    });
  });
}

function waitForSocketEvent<T>(
  socket: Socket,
  eventName: string,
  matches: (event: T) => boolean
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(eventName, listener);
      reject(new Error(`Timed out waiting for ${eventName}`));
    }, 8000);
    const listener = (payload: unknown) => {
      if (!matches(payload as T)) return;
      clearTimeout(timeout);
      socket.off(eventName, listener);
      resolve(payload as T);
    };
    socket.on(eventName, listener);
  });
}

async function waitForPending(token: string, id: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = await request<{ messages: Array<{ id: string }> }>('/api/supervisor/pending', token);
    if (result.messages.some((message) => message.id === id)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Pending message ${id} was not persisted`);
}

async function waitForMode(token: string, mode: 'human' | 'automated'):
Promise<{ mode: 'human' | 'automated'; updatedBy: string | null }> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = await request<{
      state: { mode: 'human' | 'automated'; updatedBy: string | null };
    }>('/api/supervisor/state', token);
    if (result.state.mode === mode) return result.state;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Supervision did not switch to ${mode}`);
}

async function waitForApi(): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`API did not become ready at ${baseUrl}`);
}

async function run(): Promise<void> {
  await waitForApi();
  const alicePassword = process.env.DEMO_ALICE_PASSWORD;
  const bobPassword = process.env.DEMO_BOB_PASSWORD;
  const supervisorPassword = process.env.DEMO_SUPERVISOR_PASSWORD;
  if (!alicePassword || !bobPassword || !supervisorPassword) {
    throw new Error('Load the .env demo password values before running npm run demo');
  }

  const [aliceToken, bobToken, supervisorToken] = await Promise.all([
    login('alice@example.test', alicePassword),
    login('bob@example.test', bobPassword),
    login('supervisor@example.test', supervisorPassword)
  ]);
  const created = await request<{ conversation: { id: string } }>(
    '/api/conversations', aliceToken, { recipientId: (await request<{ user: { id: string } }>('/api/me', bobToken)).user.id }
  );
  const conversationId = created.conversation.id;
  const [alice, bob, supervisor] = await Promise.all([
    connect(aliceToken), connect(bobToken), connect(supervisorToken)
  ]);

  try {
    await Promise.all([
      emitAck(alice, 'conversation:join', { conversationId }),
      emitAck(bob, 'conversation:join', { conversationId }),
      emitAck(supervisor, 'conversation:monitor', { conversationId })
    ]);

    await request('/api/supervisor/state', supervisorToken, { mode: 'human' }, 'PUT');
    console.log('Human supervision is on duty; sending a message for review.');
    const first = await emitAck<{ message: { id: string; status: string } }>(alice, 'message:send', {
      conversationId, content: 'Hello Bob, this message is held for supervisor approval.'
    });
    await waitForPending(supervisorToken, first.message.id);
    const approvedDelivery = waitForSocketEvent<{ id: string; content: string }>(
      bob, 'message:delivered', (event) => event.id === first.message.id
    );
    await request(`/api/supervisor/messages/${first.message.id}/review`, supervisorToken, { action: 'approve' });
    const approvedMessage = await approvedDelivery;
    if (approvedMessage.content !== 'Hello Bob, this message is held for supervisor approval.') {
      throw new Error('Bob received unexpected content for the approved message');
    }
    console.log('Supervisor approved the held message.');

    const second = await emitAck<{ message: { id: string; status: string } }>(alice, 'message:send', {
      conversationId, content: 'My password=demo-secret should never leave this message.'
    });
    await waitForPending(supervisorToken, second.message.id);
    const redactedDelivery = waitForSocketEvent<{ id: string; content: string; status: string }>(
      bob, 'message:delivered', (event) => event.id === second.message.id
    );
    await request(`/api/supervisor/messages/${second.message.id}/review`, supervisorToken, {
      action: 'redact', content: 'A credential was removed by the supervisor.'
    });
    const redactedMessage = await redactedDelivery;
    if (redactedMessage.content !== 'A credential was removed by the supervisor.' || redactedMessage.status !== 'redacted') {
      throw new Error('Bob did not receive the moderator-redacted message');
    }
    console.log('Supervisor redacted a credential-bearing message.');

    const heldForBreak = await emitAck<{ message: { id: string } }>(alice, 'message:send', {
      conversationId, content: 'This message is released when the supervisor takes a break.'
    });
    await waitForPending(supervisorToken, heldForBreak.message.id);
    const breakDelivery = waitForSocketEvent<{ id: string; moderationReason: string }>(
      bob, 'message:delivered', (event) => event.id === heldForBreak.message.id
    );
    await request('/api/supervisor/state', supervisorToken, { mode: 'automated' }, 'PUT');
    const releasedOnBreak = await breakDelivery;
    if (!releasedOnBreak.moderationReason?.includes('supervisor handoff')) {
      throw new Error('The supervisor-break handoff was not observable to Bob');
    }
    console.log('Supervisor break released the held message to Bob with a handoff status.');

    await request('/api/supervisor/state', supervisorToken, { mode: 'human' }, 'PUT');
    const heldForDisconnect = await emitAck<{ message: { id: string } }>(alice, 'message:send', {
      conversationId, content: 'This message is released after the supervisor disconnects.'
    });
    await waitForPending(supervisorToken, heldForDisconnect.message.id);
    const disconnectDelivery = waitForSocketEvent<{ id: string; moderationReason: string }>(
      bob, 'message:delivered', (event) => event.id === heldForDisconnect.message.id
    );
    supervisor.disconnect();
    const disconnectedState = await waitForMode(supervisorToken, 'automated');
    const releasedOnDisconnect = await disconnectDelivery;
    if (disconnectedState.updatedBy !== null || !releasedOnDisconnect.moderationReason?.includes('supervisor handoff')) {
      throw new Error('Supervisor disconnect did not trigger the automated fallback');
    }
    console.log('Last supervisor disconnect triggered automated fallback and released the pending message.');

    const automaticRedaction = await emitAck<{ message: { id: string; status: string } }>(alice, 'message:send', {
      conversationId, content: 'My api_key=demo-secret is exposed.'
    });
    console.log(`Automated moderation sanitized a credential (${automaticRedaction.message.status}).`);

    const automaticBlock = await emitAck<{ message: { id: string; status: string; moderationReason: string } }>(
      alice, 'message:send', { conversationId, content: 'I will hurt you.' }
    );
    console.log(`Automated moderation blocked unsafe content: ${automaticBlock.message.moderationReason}`);
    console.log(`Review history: GET /api/conversations/${conversationId}/messages`);
  } finally {
    alice.disconnect();
    bob.disconnect();
    supervisor.disconnect();
  }
}

run().catch((error) => {
  console.error('Demo failed', error);
  process.exitCode = 1;
});
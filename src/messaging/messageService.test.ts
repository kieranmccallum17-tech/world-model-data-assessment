import { deepEqual, equal } from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AuthUser, ChatMessage, ModerationMode, SupervisionState } from '../domain/types';
import { MessageStore, MessageService } from './messageService';

const alice: AuthUser = {
  id: 'alice', email: 'alice@example.test', displayName: 'Alice', role: 'user'
};
const supervisor: AuthUser = {
  id: 'supervisor', email: 'supervisor@example.test', displayName: 'Supervisor', role: 'supervisor'
};

class MemoryStore implements MessageStore {
  mode: ModerationMode = 'automated';
  messages = new Map<string, ChatMessage>();
  sequence = 0;

  async isMember(): Promise<boolean> { return true; }
  async getSupervisionState(): Promise<SupervisionState> {
    return { mode: this.mode, updatedBy: null, updatedAt: new Date().toISOString() };
  }
  async createMessage(input: {
    conversationId: string; senderId: string; content: string;
    status: ChatMessage['status']; mode: ModerationMode; reason?: string | null;
  }): Promise<ChatMessage> {
    this.sequence += 1;
    const now = new Date().toISOString();
    const message: ChatMessage = {
      id: `message-${this.sequence}`, conversationId: input.conversationId,
      senderId: input.senderId, content: input.content, status: input.status,
      moderationMode: input.mode, moderationReason: input.reason ?? null,
      reviewedBy: null, createdAt: now, updatedAt: now
    };
    this.messages.set(message.id, message);
    return message;
  }
  async getMessage(id: string): Promise<ChatMessage | null> { return this.messages.get(id) ?? null; }
  async updatePendingMessage(input: {
    id: string; status: Exclude<ChatMessage['status'], 'pending'>; content: string;
    reason: string; reviewerId: string | null;
  }): Promise<ChatMessage | null> {
    const message = this.messages.get(input.id);
    if (!message || message.status !== 'pending') return null;
    const updated = {
      ...message, status: input.status, content: input.content,
      moderationReason: input.reason, reviewedBy: input.reviewerId,
      updatedAt: new Date().toISOString()
    };
    this.messages.set(updated.id, updated);
    return updated;
  }
  async setSupervisionMode(mode: ModerationMode, userId: string | null): Promise<{
    state: SupervisionState; releasedMessages: ChatMessage[];
  }> {
    this.mode = mode;
    const releasedMessages: ChatMessage[] = [];
    if (mode === 'automated') {
      for (const message of this.messages.values()) {
        if (message.status === 'pending') {
          const updated = {
            ...message,
            status: message.moderationReason ? 'redacted' as const : 'delivered' as const,
            moderationReason: message.moderationReason ?? 'Delivered after supervisor handoff to automated supervision.'
          };
          this.messages.set(updated.id, updated);
          releasedMessages.push(updated);
        }
      }
    }
    return { state: { mode, updatedBy: userId, updatedAt: new Date().toISOString() }, releasedMessages };
  }
  async getPendingMessages(): Promise<ChatMessage[]> {
    return [...this.messages.values()].filter((message) => message.status === 'pending');
  }
}

describe('message supervision pipeline', () => {
  it('persists and publishes an allowed message before delivery', async () => {
    const { store, events, service } = createHarness();
    const message = await service.send(alice, 'conversation-1', 'Hello Bob');
    equal(message.status, 'delivered');
    equal(store.messages.get(message.id)?.content, 'Hello Bob');
    deepEqual(events.delivered, [message]);
  });

  it('redacts automated findings and never persists blocked content', async () => {
    const { store, service } = createHarness();
    const redacted = await service.send(alice, 'conversation-1', 'password=secret123');
    equal(redacted.status, 'redacted');
    equal(redacted.content, 'password=[REDACTED]');

    const blocked = await service.send(alice, 'conversation-1', 'I will hurt you.');
    equal(blocked.status, 'blocked');
    equal(blocked.content, '');
    equal(store.messages.get(blocked.id)?.content, '');
  });

  it('supports supervisor approval, blocking, and explicit redaction', async () => {
    const { events, service } = createHarness();
    await service.setMode(supervisor, 'human');
    const approved = await service.send(alice, 'conversation-1', 'Please review this.');
    equal(approved.status, 'pending');
    deepEqual(events.pending, [approved]);
    equal((await service.review(supervisor, approved.id, { action: 'approve' })).status, 'delivered');

    const blocked = await service.send(alice, 'conversation-1', 'Block this message.');
    const result = await service.review(supervisor, blocked.id, { action: 'block' });
    deepEqual([result.status, result.content, result.moderationReason], [
      'blocked', '', 'Message removed by moderator.'
    ]);

    const redacted = await service.send(alice, 'conversation-1', 'Please hide this detail.');
    const edited = await service.review(supervisor, redacted.id, {
      action: 'redact', content: 'This detail was removed.'
    });
    deepEqual([edited.status, edited.content], ['redacted', 'This detail was removed.']);
  });

  it('automatically delivers pending messages after the supervisor goes on break', async () => {
    const { store, events, service } = createHarness();
    await service.setMode(supervisor, 'human');
    const pending = await service.send(alice, 'conversation-1', 'Held for human review');
    equal(pending.status, 'pending');

    await service.setMode(supervisor, 'automated');
    equal(store.mode, 'automated');
    deepEqual([store.messages.get(pending.id)?.status, store.messages.get(pending.id)?.moderationReason], [
      'delivered', 'Delivered after supervisor handoff to automated supervision.'
    ]);
    deepEqual(events.supervision.at(-1), {
      mode: 'automated', updatedBy: 'supervisor', reason: 'supervisor_break'
    });
  });
});

function createHarness() {
  const store = new MemoryStore();
  const events = {
    status: [] as ChatMessage[],
    delivered: [] as ChatMessage[],
    pending: [] as ChatMessage[],
    supervision: [] as Array<{ mode: ModerationMode; updatedBy: string | null; reason: string }>
  };
  const service = new MessageService(store, {
    status: (message) => events.status.push(message),
    delivered: (message) => events.delivered.push(message),
    pending: (message) => events.pending.push(message),
    supervision: (mode, updatedBy, reason) => events.supervision.push({ mode, updatedBy, reason })
  });
  return { store, events, service };
}
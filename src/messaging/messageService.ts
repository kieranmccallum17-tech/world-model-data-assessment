import { badRequest, notFound } from '../domain/errors';
import { AuthUser, ChatMessage, ModerationMode, MessageStatus } from '../domain/types';
import { ChatRepository } from '../persistence/chatRepository';
import { moderateAutomatically } from '../moderation/automatedPolicy';

export type MessageStore = Pick<ChatRepository,
  'isMember' | 'getSupervisionState' | 'createMessage' | 'getMessage' |
  'updatePendingMessage' | 'setSupervisionMode'>;

export interface MessageEvents {
  status(message: ChatMessage): void;
  delivered(message: ChatMessage): void;
  pending(message: ChatMessage): void;
  supervision(mode: ModerationMode, updatedBy: string | null, reason: string): void;
}

export type ReviewDecision =
  | { action: 'approve' }
  | { action: 'block' }
  | { action: 'redact'; content: string };

export class MessageService {
  constructor(private readonly repository: MessageStore, private readonly events: MessageEvents) {}

  async send(sender: AuthUser, conversationId: string, content: string): Promise<ChatMessage> {
    if (!(await this.repository.isMember(conversationId, sender.id))) {
      throw notFound('Conversation not found');
    }

    const automated = moderateAutomatically(content);
    const mode = await this.repository.getSupervisionState();
    let status: MessageStatus;
    let storedContent: string;
    let reason: string | null = null;

    if (automated.action === 'block') {
      status = 'blocked';
      storedContent = '';
      reason = automated.reason;
    } else if (mode.mode === 'human') {
      status = 'pending';
      storedContent = automated.content;
      reason = automated.action === 'redact' ? automated.reason : null;
    } else if (automated.action === 'redact') {
      status = 'redacted';
      storedContent = automated.content;
      reason = automated.reason;
    } else {
      status = 'delivered';
      storedContent = content;
    }

    const message = await this.repository.createMessage({
      conversationId, senderId: sender.id, content: storedContent, status, mode: mode.mode, reason
    });
    this.publish(message);
    return message;
  }

  async review(reviewer: AuthUser, id: string, decision: ReviewDecision): Promise<ChatMessage> {
    const current = await this.repository.getMessage(id);
    if (!current) throw notFound('Message not found');
    if (current.status !== 'pending') throw badRequest('Message is no longer awaiting review');

    let status: Exclude<MessageStatus, 'pending'>;
    let content = current.content;
    let reason: string;
    if (decision.action === 'approve') {
      status = 'delivered';
      reason = 'Message approved by supervisor.';
    } else if (decision.action === 'block') {
      status = 'blocked';
      content = '';
      reason = 'Message removed by moderator.';
    } else {
      status = 'redacted';
      content = decision.content;
      reason = 'Message edited by moderator.';
    }

    const updated = await this.repository.updatePendingMessage({
      id, status, content, reason, reviewerId: reviewer.id
    });
    if (!updated) throw badRequest('Message is no longer awaiting review');
    this.publish(updated);
    return updated;
  }

  async setMode(reviewer: AuthUser | null, mode: ModerationMode): Promise<void> {
    if (mode === 'human' && !reviewer) throw badRequest('A human supervisor must be present');
    const { state, releasedMessages } = await this.repository.setSupervisionMode(mode, reviewer?.id ?? null);
    this.events.supervision(
      state.mode,
      state.updatedBy,
      mode === 'human' ? 'supervisor_on_duty' : reviewer ? 'supervisor_break' : 'supervisor_disconnected'
    );
    for (const message of releasedMessages) this.publish(message);
  }

  private publish(message: ChatMessage): void {
    this.events.status(message);
    if (message.status === 'delivered' || message.status === 'redacted') {
      this.events.delivered(message);
    } else if (message.status === 'pending') {
      this.events.pending(message);
    }
  }
}
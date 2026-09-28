import { Server } from 'socket.io';
import { ChatMessage, ModerationMode } from '../domain/types';
import { MessageEvents } from '../messaging/messageService';

export class SocketMessageEvents implements MessageEvents {
  constructor(private readonly io: Server) {}

  status(message: ChatMessage): void {
    const event = {
      id: message.id,
      conversationId: message.conversationId,
      status: message.status,
      moderationReason: message.moderationReason,
      updatedAt: message.updatedAt
    };
    this.io.to(`conversation:${message.conversationId}`).emit('message:status', event);
    this.io.to(`monitor:${message.conversationId}`).emit('message:observed:status', event);
  }

  delivered(message: ChatMessage): void {
    const event = {
      id: message.id,
      conversationId: message.conversationId,
      senderId: message.senderId,
      content: message.content,
      status: message.status,
      moderationReason: message.moderationReason,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt
    };
    this.io.to(`conversation:${message.conversationId}`).emit('message:delivered', event);
    this.io.to(`monitor:${message.conversationId}`).emit('message:observed', event);
  }

  pending(message: ChatMessage): void {
    this.io.to(`monitor:${message.conversationId}`).emit('message:pending', message);
  }

  supervision(mode: ModerationMode, updatedBy: string | null, reason: string): void {
    this.io.emit('supervision:state', { mode, updatedBy, reason, changedAt: new Date().toISOString() });
  }
}

export class DelegatingMessageEvents implements MessageEvents {
  private target?: MessageEvents;

  setTarget(target: MessageEvents): void {
    this.target = target;
  }

  status(message: ChatMessage): void {
    this.requireTarget().status(message);
  }

  delivered(message: ChatMessage): void {
    this.requireTarget().delivered(message);
  }

  pending(message: ChatMessage): void {
    this.requireTarget().pending(message);
  }

  supervision(mode: ModerationMode, updatedBy: string | null, reason: string): void {
    this.requireTarget().supervision(mode, updatedBy, reason);
  }

  private requireTarget(): MessageEvents {
    if (!this.target) throw new Error('Message event transport is not initialized');
    return this.target;
  }
}
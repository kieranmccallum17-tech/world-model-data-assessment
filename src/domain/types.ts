export type Role = 'user' | 'supervisor';
export type ModerationMode = 'automated' | 'human';
export type MessageStatus = 'pending' | 'delivered' | 'blocked' | 'redacted';

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  role: Role;
}

export interface Conversation {
  id: string;
  createdAt: string;
  participants: AuthUser[];
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  senderId: string;
  content: string;
  status: MessageStatus;
  moderationMode: ModerationMode;
  moderationReason: string | null;
  reviewedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SupervisionState {
  mode: ModerationMode;
  updatedBy: string | null;
  updatedAt: string;
}
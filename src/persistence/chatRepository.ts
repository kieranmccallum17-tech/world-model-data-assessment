import { Pool, PoolClient } from 'pg';
import { AuthUser, ChatMessage, Conversation, MessageStatus, ModerationMode, SupervisionState } from '../domain/types';

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  role: AuthUser['role'];
}

interface MessageRow {
  id: string;
  conversation_id: string;
  sender_id: string;
  content: string;
  status: MessageStatus;
  moderation_mode: ModerationMode;
  moderation_reason: string | null;
  reviewed_by: string | null;
  created_at: Date;
  updated_at: Date;
}

const userFields = `id, email, display_name, password_hash, role`;
const messageFields = `id, conversation_id, sender_id, content, status,
  moderation_mode, moderation_reason, reviewed_by, created_at, updated_at`;

export const toAuthUser = (row: UserRow): AuthUser => ({
  id: row.id,
  email: row.email,
  displayName: row.display_name,
  role: row.role
});

function toMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    content: row.content,
    status: row.status,
    moderationMode: row.moderation_mode,
    moderationReason: row.moderation_reason,
    reviewedBy: row.reviewed_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

export class ChatRepository {
  constructor(private readonly pool: Pool) {}

  async findUserByEmail(email: string): Promise<(AuthUser & { passwordHash: string }) | null> {
    const result = await this.pool.query<UserRow>(
      `SELECT ${userFields} FROM users WHERE email = $1`, [email.toLowerCase()]
    );
    const row = result.rows[0];
    return row ? { ...toAuthUser(row), passwordHash: row.password_hash } : null;
  }

  async findUserById(id: string): Promise<AuthUser | null> {
    const result = await this.pool.query<UserRow>(
      `SELECT ${userFields} FROM users WHERE id = $1`, [id]
    );
    return result.rows[0] ? toAuthUser(result.rows[0]) : null;
  }

  async createUser(input: {
    email: string;
    displayName: string;
    passwordHash: string;
    role: AuthUser['role'];
  }): Promise<AuthUser> {
    const result = await this.pool.query<UserRow>(
      `INSERT INTO users (email, display_name, password_hash, role)
       VALUES ($1, $2, $3, $4) RETURNING ${userFields}`,
      [input.email.toLowerCase(), input.displayName, input.passwordHash, input.role]
    );
    return toAuthUser(result.rows[0]!);
  }

  async createConversation(ownerId: string, otherUserId: string): Promise<Conversation> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query<{ id: string; created_at: Date }>(
        `SELECT c.id, c.created_at
         FROM conversations c
         JOIN conversation_members a ON a.conversation_id = c.id AND a.user_id = $1
         JOIN conversation_members b ON b.conversation_id = c.id AND b.user_id = $2
         WHERE (SELECT count(*) FROM conversation_members m WHERE m.conversation_id = c.id) = 2
         LIMIT 1`, [ownerId, otherUserId]
      );
      const row = existing.rows[0] ?? await this.insertConversation(client, ownerId, otherUserId);
      const participants = await this.getParticipants(client, row.id);
      await client.query('COMMIT');
      return { id: row.id, createdAt: row.created_at.toISOString(), participants };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async insertConversation(client: PoolClient, ownerId: string, otherUserId: string) {
    const created = await client.query<{ id: string; created_at: Date }>(
      'INSERT INTO conversations DEFAULT VALUES RETURNING id, created_at'
    );
    const row = created.rows[0]!;
    await client.query(
      'INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2), ($1, $3)',
      [row.id, ownerId, otherUserId]
    );
    return row;
  }

  private async getParticipants(client: PoolClient, conversationId: string): Promise<AuthUser[]> {
    const result = await client.query<UserRow>(
      `SELECT u.${userFields.split(', ').join(', u.')} FROM users u
       JOIN conversation_members m ON m.user_id = u.id WHERE m.conversation_id = $1`,
      [conversationId]
    );
    return result.rows.map(toAuthUser);
  }

  async listConversations(user: AuthUser): Promise<Conversation[]> {
    const result = await this.pool.query<{
      conversation_id: string; created_at: Date; user_id: string; email: string;
      display_name: string; role: AuthUser['role']; password_hash: string;
    }>(
      `SELECT c.id AS conversation_id, c.created_at, u.id AS user_id, u.email,
              u.display_name, u.role, u.password_hash
       FROM conversations c
       JOIN conversation_members mine ON mine.conversation_id = c.id
       JOIN conversation_members members ON members.conversation_id = c.id
       JOIN users u ON u.id = members.user_id
       WHERE ($1::text = 'supervisor' OR mine.user_id = $2)
       ORDER BY c.created_at DESC`, [user.role, user.id]
    );
    const conversations = new Map<string, Conversation>();
    for (const row of result.rows) {
      let conversation = conversations.get(row.conversation_id);
      if (!conversation) {
        conversation = { id: row.conversation_id, createdAt: row.created_at.toISOString(), participants: [] };
        conversations.set(row.conversation_id, conversation);
      }
      conversation.participants.push({
        id: row.user_id, email: row.email, displayName: row.display_name, role: row.role
      });
    }
    return [...conversations.values()];
  }

  async isMember(conversationId: string, userId: string): Promise<boolean> {
    const result = await this.pool.query(
      'SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
      [conversationId, userId]
    );
    return result.rowCount === 1;
  }

  async getMessages(conversationId: string, limit: number): Promise<ChatMessage[]> {
    const result = await this.pool.query<MessageRow>(
      `SELECT ${messageFields} FROM messages WHERE conversation_id = $1
       ORDER BY created_at DESC, id DESC LIMIT $2`, [conversationId, limit]
    );
    return result.rows.reverse().map(toMessage);
  }

  async createMessage(input: {
    conversationId: string; senderId: string; content: string; status: MessageStatus;
    mode: ModerationMode; reason?: string | null;
  }): Promise<ChatMessage> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const state = await client.query<{ mode: ModerationMode }>(
        'SELECT mode FROM supervision_state WHERE singleton = TRUE FOR SHARE'
      );
      const mode = state.rows[0]!.mode;
      const safeStatus = input.status === 'pending'
        ? input.reason?.startsWith('Sensitive credential-like text') ? 'redacted' : 'delivered'
        : input.status;
      const status = mode === 'human' && safeStatus !== 'blocked' ? 'pending' : safeStatus;
      const result = await client.query<MessageRow>(
        `INSERT INTO messages (conversation_id, sender_id, content, status, moderation_mode, moderation_reason)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${messageFields}`,
        [input.conversationId, input.senderId, input.content, status, mode, input.reason ?? null]
      );
      await client.query('COMMIT');
      return toMessage(result.rows[0]!);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getMessage(id: string): Promise<ChatMessage | null> {
    const result = await this.pool.query<MessageRow>(
      `SELECT ${messageFields} FROM messages WHERE id = $1`, [id]
    );
    return result.rows[0] ? toMessage(result.rows[0]) : null;
  }

  async updatePendingMessage(input: {
    id: string; status: Exclude<MessageStatus, 'pending'>; content: string;
    reason: string; reviewerId: string | null;
  }): Promise<ChatMessage | null> {
    const result = await this.pool.query<MessageRow>(
      `UPDATE messages SET status = $2, content = $3, moderation_reason = $4,
                           reviewed_by = $5, updated_at = now()
       WHERE id = $1 AND status = 'pending' RETURNING ${messageFields}`,
      [input.id, input.status, input.content, input.reason, input.reviewerId]
    );
    return result.rows[0] ? toMessage(result.rows[0]) : null;
  }

  async getPendingMessages(): Promise<ChatMessage[]> {
    const result = await this.pool.query<MessageRow>(
      `SELECT ${messageFields} FROM messages WHERE status = 'pending' ORDER BY created_at`
    );
    return result.rows.map(toMessage);
  }

  async getSupervisionState(): Promise<SupervisionState> {
    const result = await this.pool.query<{
      mode: ModerationMode; updated_by: string | null; updated_at: Date;
    }>('SELECT mode, updated_by, updated_at FROM supervision_state WHERE singleton = TRUE');
    const row = result.rows[0]!;
    return { mode: row.mode, updatedBy: row.updated_by, updatedAt: row.updated_at.toISOString() };
  }

  async setSupervisionMode(
    mode: ModerationMode,
    userId: string | null
  ): Promise<{ state: SupervisionState; releasedMessages: ChatMessage[] }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{
        mode: ModerationMode; updated_by: string | null; updated_at: Date;
      }>(
        `UPDATE supervision_state SET mode = $1, updated_by = $2, updated_at = now()
         WHERE singleton = TRUE RETURNING mode, updated_by, updated_at`, [mode, userId]
      );
      const row = result.rows[0]!;
      let releasedMessages: ChatMessage[] = [];
      if (mode === 'automated') {
        const released = await client.query<MessageRow>(
          `UPDATE messages SET
             status = CASE WHEN moderation_reason = 'Sensitive credential-like text was redacted automatically.'
                           THEN 'redacted' ELSE 'delivered' END,
             moderation_reason = CASE WHEN moderation_reason = 'Sensitive credential-like text was redacted automatically.'
                                      THEN moderation_reason || ' Delivered after supervisor handoff.'
                                      ELSE 'Delivered after supervisor handoff to automated supervision.' END,
             reviewed_by = NULL, updated_at = now()
           WHERE status = 'pending' RETURNING ${messageFields}`
        );
        releasedMessages = released.rows.map(toMessage);
      }
      await client.query('COMMIT');
      return {
        state: { mode: row.mode, updatedBy: row.updated_by, updatedAt: row.updated_at.toISOString() },
        releasedMessages
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
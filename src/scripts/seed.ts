import bcrypt from 'bcryptjs';
import { config } from '../config';
import { pool, initializeDatabase } from '../db/pool';
import { ChatRepository } from '../persistence/chatRepository';

interface SeedIdentity {
  email: string;
  displayName: string;
  role: 'user' | 'supervisor';
  password: string | undefined;
}

async function seed(): Promise<void> {
  if (config.NODE_ENV === 'production') throw new Error('Demo seeding is disabled in production');
  const identities: SeedIdentity[] = [
    { email: 'alice@example.test', displayName: 'Alice', role: 'user', password: process.env.DEMO_ALICE_PASSWORD },
    { email: 'bob@example.test', displayName: 'Bob', role: 'user', password: process.env.DEMO_BOB_PASSWORD },
    {
      email: 'supervisor@example.test', displayName: 'Supervisor', role: 'supervisor',
      password: process.env.DEMO_SUPERVISOR_PASSWORD
    }
  ];
  if (identities.some((identity) => !identity.password || identity.password.length < 12)) {
    throw new Error('Set all DEMO_*_PASSWORD values to passwords of at least 12 characters');
  }

  await initializeDatabase();
  const ids = new Map<string, string>();
  for (const identity of identities) {
    const passwordHash = await bcrypt.hash(identity.password!, 12);
    const result = await pool.query<{ id: string }>(
      `INSERT INTO users (email, display_name, password_hash, role)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name,
         password_hash = EXCLUDED.password_hash, role = EXCLUDED.role
       RETURNING id`,
      [identity.email, identity.displayName, passwordHash, identity.role]
    );
    ids.set(identity.email, result.rows[0]!.id);
  }

  const repository = new ChatRepository(pool);
  await repository.createConversation(ids.get('alice@example.test')!, ids.get('bob@example.test')!);
  console.log('Seeded Alice, Bob, Supervisor, and their private conversation.');
}

seed().catch((error) => {
  console.error('Seeding failed', error);
  process.exitCode = 1;
}).finally(async () => {
  await pool.end();
});
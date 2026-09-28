import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';
import { config } from '../config';

export const pool = new Pool({ connectionString: config.DATABASE_URL, max: 20 });

export async function initializeDatabase(): Promise<void> {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = await readFile(schemaPath, 'utf8');
  await pool.query(schema);
}
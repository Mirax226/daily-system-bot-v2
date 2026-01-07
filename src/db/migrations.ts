import { Client } from 'pg';
import fs from 'node:fs/promises';
import path from 'node:path';
import { logError, logInfo } from '../utils/logger';

const MIGRATIONS_TABLE = 'schema_migrations';

type MigrationRow = {
  id: number;
  filename: string;
  applied_at: string;
};

export async function runMigrations(): Promise<void> {
  const connectionString =
    process.env.SUPABASE_DB_CONNECTION_STRING ?? process.env.SUPABASE_DSN_DAILY_SYSTEM;

  if (!connectionString) {
    logError('DB connection string is not set', { scope: 'migrations' });
    throw new Error('Missing DB connection string for migrations');
  }

  const client = new Client({ connectionString });

  await client.connect();

  try {
    await ensureMigrationsTable(client);
    const applied = await loadAppliedMigrations(client);
    const appliedSet = new Set(applied.map((migration) => migration.filename));

    const migrationsDir = path.join(process.cwd(), 'supabase', 'migrations');
    const files = (await fs.readdir(migrationsDir))
      .filter((file) => file.endsWith('.sql'))
      .sort();

    for (const file of files) {
      if (appliedSet.has(file)) {
        continue;
      }

      const fullPath = path.join(migrationsDir, file);
      const sql = await fs.readFile(fullPath, 'utf8');

      logInfo('Running migration', { scope: 'migrations', file });

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(`INSERT INTO ${MIGRATIONS_TABLE} (filename) VALUES ($1)`, [file]);
        await client.query('COMMIT');
        logInfo('Migration applied', { scope: 'migrations', file });
      } catch (err) {
        await client.query('ROLLBACK');
        logError('Migration failed', { scope: 'migrations', file, err });
        throw err;
      }
    }

    logInfo('All migrations up to date', { scope: 'migrations' });
  } finally {
    await client.end();
  }
}

async function ensureMigrationsTable(client: Client): Promise<void> {
  const sql = `
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      id SERIAL PRIMARY KEY,
      filename TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `;

  await client.query(sql);
}

async function loadAppliedMigrations(client: Client): Promise<MigrationRow[]> {
  const { rows } = await client.query<MigrationRow>(
    `SELECT id, filename, applied_at FROM ${MIGRATIONS_TABLE} ORDER BY id ASC;`
  );

  return rows;
}

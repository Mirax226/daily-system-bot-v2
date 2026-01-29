import { Client } from 'pg';
import path from 'node:path';
import { config } from '../config';
import { logError, logInfo } from '../utils/logger';
import {
  ensureMigrationsTable,
  listMigrationFiles,
  loadAppliedMigrations,
  readMigrationSql,
  recordMigration,
  type MigrationSummary
} from './migrations';

const DEFAULT_MIGRATIONS_DIR = path.join(process.cwd(), 'db', 'migrations');

type SchemaSyncResult = MigrationSummary & { durationMs: number };

const resolveMigrationsEnabled = (): boolean => config.db.migrationsEnabled;

export const schemaSync = async (): Promise<SchemaSyncResult> => {
  if (!resolveMigrationsEnabled()) {
    logInfo('Schema sync skipped (DB_MIGRATIONS_ENABLED=false)', { scope: 'schemaSync' });
    return { appliedCount: 0, skippedCount: 0, durationMs: 0 };
  }

  const connectionString = config.db.connectionString;
  if (!connectionString) {
    logError('DB connection string missing for schema sync', { scope: 'schemaSync' });
    throw new Error('Missing SUPABASE_DB_CONNECTION for schema sync');
  }

  const start = Date.now();
  const client = new Client({ connectionString });
  await client.connect();

  try {
    await ensureMigrationsTable(client);
    const applied = await loadAppliedMigrations(client);
    const appliedSet = new Set(applied.map((migration) => migration.filename));

    const files = await listMigrationFiles(DEFAULT_MIGRATIONS_DIR);
    let appliedCount = 0;
    let skippedCount = 0;

    for (const file of files) {
      if (appliedSet.has(file)) {
        skippedCount += 1;
        continue;
      }

      const sql = await readMigrationSql(DEFAULT_MIGRATIONS_DIR, file);
      logInfo('Applying migration', { scope: 'schemaSync', file });

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await recordMigration(client, file);
        await client.query('COMMIT');
        appliedCount += 1;
        logInfo('Migration applied', { scope: 'schemaSync', file });
      } catch (error) {
        await client.query('ROLLBACK');
        const message = error instanceof Error ? error.message : String(error);
        logError('Migration failed', { scope: 'schemaSync', file, error: message });
        throw new Error(`Migration failed (${file}): ${message}`);
      }
    }

    const durationMs = Date.now() - start;
    logInfo('Schema sync complete', {
      scope: 'schemaSync',
      applied_count: appliedCount,
      skipped_count: skippedCount,
      duration_ms: durationMs
    });

    return { appliedCount, skippedCount, durationMs };
  } finally {
    await client.end();
  }
};

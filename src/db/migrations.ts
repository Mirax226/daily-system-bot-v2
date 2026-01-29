import fs from 'node:fs/promises';
import path from 'node:path';
import type { Client } from 'pg';

const MIGRATIONS_TABLE = 'schema_migrations';

export type MigrationRow = {
  id: number;
  filename: string;
  applied_at: string;
};

export type MigrationSummary = {
  appliedCount: number;
  skippedCount: number;
};

export const ensureMigrationsTable = async (client: Client): Promise<void> => {
  const sql = `
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      id SERIAL PRIMARY KEY,
      filename TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `;
  await client.query(sql);
};

export const loadAppliedMigrations = async (client: Client): Promise<MigrationRow[]> => {
  const { rows } = await client.query<MigrationRow>(
    `SELECT id, filename, applied_at FROM ${MIGRATIONS_TABLE} ORDER BY id ASC;`
  );
  return rows;
};

export const listMigrationFiles = async (directory: string): Promise<string[]> => {
  const entries = await fs.readdir(directory);
  return entries.filter((file) => file.endsWith('.sql')).sort();
};

export const readMigrationSql = async (directory: string, filename: string): Promise<string> => {
  const fullPath = path.join(directory, filename);
  return fs.readFile(fullPath, 'utf8');
};

export const recordMigration = async (client: Client, filename: string): Promise<void> => {
  await client.query(`INSERT INTO ${MIGRATIONS_TABLE} (filename) VALUES ($1)`, [filename]);
};

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Pool, QueryResultRow } from 'pg';
import { config } from './config';
import { type Database } from './types/supabase';

let supabaseClient: SupabaseClient<Database> | null = null;
let pgPool: Pool | null = null;

export function getSupabaseClient(): SupabaseClient<Database> {
  if (supabaseClient) {
    return supabaseClient;
  }

  const { url, serviceRoleKey } = config.supabase;

  if (!url || !serviceRoleKey) {
    throw new Error('Supabase configuration is missing URL or service role key');
  }

  supabaseClient = createClient<Database>(url, serviceRoleKey);
  return supabaseClient;
}

export function getDbPool(): Pool {
  if (pgPool) {
    return pgPool;
  }

  const connectionString =
    process.env.SUPABASE_DB_CONNECTION_STRING ?? process.env.SUPABASE_DSN_DAILY_SYSTEM;

  if (!connectionString) {
    throw new Error('Database connection string is missing');
  }

  pgPool = new Pool({ connectionString });
  return pgPool;
}

export async function queryDb<T extends QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<{ rows: T[] }> {
  const pool = getDbPool();
  return pool.query<T>(sql, params);
}

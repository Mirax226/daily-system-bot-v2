import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from './config';
import { type Database } from './types/supabase';

let supabaseClient: SupabaseClient<Database> | null = null;

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

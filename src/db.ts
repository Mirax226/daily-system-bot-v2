import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from './config';

let supabaseClient: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (supabaseClient) {
    return supabaseClient;
  }

  const { url, serviceRoleKey } = config.supabase;

  if (!url || !serviceRoleKey) {
    throw new Error('Supabase configuration is missing URL or service role key');
  }

  supabaseClient = createClient(url, serviceRoleKey);
  return supabaseClient;
}

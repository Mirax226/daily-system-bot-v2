import crypto from 'crypto';
import { getSupabaseClient } from '../db';
import type { Database } from '../types/supabase';

const CALLBACK_TOKENS_TABLE = 'callback_tokens';
const DEFAULT_TTL_MINUTES = 15;

const randomToken = (): string => crypto.randomBytes(9).toString('base64url').slice(0, 12);

export async function createCallbackToken(params: {
  userId?: string;
  payload: unknown;
  ttlMinutes?: number;
}): Promise<string> {
  const client = getSupabaseClient();
  const ttl = params.ttlMinutes ?? DEFAULT_TTL_MINUTES;
  const expiresAt = new Date(Date.now() + ttl * 60 * 1000).toISOString();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = randomToken();
    const row: Database['public']['Tables'][typeof CALLBACK_TOKENS_TABLE]['Insert'] = {
      token,
      user_id: params.userId ?? null,
      payload_json: params.payload as Record<string, unknown>,
      expires_at: expiresAt
    };

    const { error } = await client.from(CALLBACK_TOKENS_TABLE).insert(row);
    if (!error) return token;
    if (error.code !== '23505') {
      console.error({ scope: 'callback_tokens', event: 'insert_error', token, error });
      throw new Error(`Failed to create callback token: ${error.message}`);
    }
    // collision, retry
  }

  throw new Error('Failed to create callback token after retries');
}

export async function consumeCallbackToken(token: string): Promise<unknown | null> {
  const client = getSupabaseClient();
  const { data, error } = await client
    .from(CALLBACK_TOKENS_TABLE)
    .delete()
    .eq('token', token)
    .select('payload_json')
    .maybeSingle();

  if (error) {
    console.error({ scope: 'callback_tokens', event: 'consume_error', token, error });
    throw new Error(`Failed to consume callback token: ${error.message}`);
  }

  return data?.payload_json ?? null;
}

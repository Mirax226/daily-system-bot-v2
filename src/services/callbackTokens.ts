import crypto from 'crypto';
import { getSupabaseClient } from '../db';
import type { Database } from '../types/supabase';

const CALLBACK_TOKENS_TABLE = 'callback_tokens';
const DEFAULT_TTL_MINUTES = 30;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const randomToken = (): string => crypto.randomBytes(9).toString('base64url').slice(0, 12);

export async function createCallbackToken(params: {
  userId?: string; // must be users.id uuid, not telegram id
  payload: any;
  ttlMinutes?: number;
}): Promise<string> {
  const client = getSupabaseClient();
  const ttl = params.ttlMinutes ?? DEFAULT_TTL_MINUTES;
  const expiresAt = new Date(Date.now() + ttl * 60 * 1000).toISOString();
  const dbUserId = params.userId && UUID_REGEX.test(params.userId) ? params.userId : null;
  if (params.userId && !dbUserId) {
    console.debug({ scope: 'callback_tokens', event: 'user_id_ignored', userId: params.userId });
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = randomToken();
    const row: Database['public']['Tables'][typeof CALLBACK_TOKENS_TABLE]['Insert'] = {
      token,
      user_id: dbUserId,
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

export async function consumeCallbackToken(token: string): Promise<any | null> {
  const client = getSupabaseClient();
  const { data, error } = await client
    .from(CALLBACK_TOKENS_TABLE)
    .delete()
    .eq('token', token)
    .gt('expires_at', new Date().toISOString())
    .select('payload_json')
    .maybeSingle();

  if (error) {
    console.error({ scope: 'callback_tokens', event: 'consume_error', token, error });
    throw new Error(`Failed to consume callback token: ${error.message}`);
  }

  return data?.payload_json ?? null;
}

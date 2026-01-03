import type { PostgrestError } from '@supabase/supabase-js';
import { getSupabaseClient } from '../db';
import type { Database, XpLedgerRow } from '../types/supabase';

const XP_LEDGER_TABLE = 'xp_ledger';

type Client = ReturnType<typeof getSupabaseClient>;

const isMissingTable = (error: PostgrestError | null): boolean =>
  Boolean(error?.code === '42P01' || error?.message?.toLowerCase().includes('relation') && error?.message?.includes('does not exist'));

const handleMissing = (error: PostgrestError | null, context: Record<string, unknown>) => {
  console.warn({ scope: 'xp_ledger', event: 'missing_table', context, error });
};

export async function addXpDelta(
  params: { userId: string; delta: number; reason: string; refType?: string | null; refId?: string | null; metadata?: Record<string, unknown> | null },
  client: Client = getSupabaseClient()
): Promise<void> {
  const payload: Database['public']['Tables']['xp_ledger']['Insert'] = {
    user_id: params.userId,
    delta: params.delta,
    reason: params.reason,
    ref_type: params.refType ?? null,
    ref_id: params.refId ?? null,
    metadata_json: params.metadata ?? {}
  };

  const { error } = await client.from(XP_LEDGER_TABLE).insert(payload);

  if (error) {
    if (isMissingTable(error)) {
      handleMissing(error, { action: 'insert', payload });
      return;
    }
    console.error({ scope: 'xp_ledger', event: 'insert_error', payload, error });
    throw new Error(`Failed to add XP delta: ${error.message}`);
  }
}

export async function getXpBalance(userId: string, client: Client = getSupabaseClient()): Promise<number> {
  const { data, error } = await client.from(XP_LEDGER_TABLE).select('delta').eq('user_id', userId);

  if (error) {
    if (isMissingTable(error)) {
      handleMissing(error, { action: 'balance', userId });
      return 0;
    }
    console.error({ scope: 'xp_ledger', event: 'balance_error', userId, error });
    throw new Error(`Failed to load XP balance: ${error.message}`);
  }

  const rows = (data as XpLedgerRow[]) ?? [];
  return rows.reduce((sum, row) => sum + (row.delta ?? 0), 0);
}

export async function getXpSummary(
  userId: string,
  client: Client = getSupabaseClient()
): Promise<{ earned: number; spent: number; net: number }> {
  const { data, error } = await client.from(XP_LEDGER_TABLE).select('delta').eq('user_id', userId);

  if (error) {
    if (isMissingTable(error)) {
      handleMissing(error, { action: 'summary', userId });
      return { earned: 0, spent: 0, net: 0 };
    }
    console.error({ scope: 'xp_ledger', event: 'summary_error', userId, error });
    throw new Error(`Failed to load XP summary: ${error.message}`);
  }

  const rows = (data as XpLedgerRow[]) ?? [];
  let earned = 0;
  let spent = 0;
  for (const row of rows) {
    if (typeof row.delta === 'number') {
      if (row.delta > 0) earned += row.delta;
      if (row.delta < 0) spent += Math.abs(row.delta);
    }
  }
  return { earned, spent, net: earned - spent };
}

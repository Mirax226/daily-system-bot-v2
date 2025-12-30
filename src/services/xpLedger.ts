import { getSupabaseClient } from '../db';
import type { Database, XpLedgerRow } from '../types/supabase';

const XP_LEDGER_TABLE = 'xp_ledger';

type Client = ReturnType<typeof getSupabaseClient>;

export async function addXpDelta(
  params: { userId: string; delta: number; reason: string; refType?: string | null; refId?: string | null },
  client: Client = getSupabaseClient()
): Promise<void> {
  const payload: Database['public']['Tables']['xp_ledger']['Insert'] = {
    user_id: params.userId,
    delta: params.delta,
    reason: params.reason,
    ref_type: params.refType ?? null,
    ref_id: params.refId ?? null
  };

  const { error } = await client.from(XP_LEDGER_TABLE).insert(payload);

  if (error) {
    console.error({ scope: 'xp_ledger', event: 'insert_error', payload, error });
    throw new Error(`Failed to add XP delta: ${error.message}`);
  }
}

export async function getXpBalance(userId: string, client: Client = getSupabaseClient()): Promise<number> {
  const { data, error } = await client
    .from(XP_LEDGER_TABLE)
    .select('delta')
    .eq('user_id', userId);

  if (error) {
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
  const { data, error } = await client
    .from(XP_LEDGER_TABLE)
    .select('delta')
    .eq('user_id', userId);

  if (error) {
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

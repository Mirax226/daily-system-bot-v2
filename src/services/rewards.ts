import type { PostgrestError } from '@supabase/supabase-js';
import { getSupabaseClient } from '../db';
import type { RewardRow } from '../types/supabase';
import { addXpDelta } from './xpLedger';

const REWARDS_TABLE = 'rewards';
const PURCHASES_TABLE = 'reward_purchases';

const defaultRewards: { title: string; description?: string; xp_cost: number }[] = [
  { title: 'Focus Tea', xp_cost: 50 },
  { title: 'Pomodoro Break (30 min)', xp_cost: 80 },
  { title: 'Movie Ticket', xp_cost: 200 },
  { title: 'New Book', xp_cost: 250 },
  { title: 'Favorite Snack', xp_cost: 60 },
  { title: 'Gaming Hour', xp_cost: 120 },
  { title: 'Rest Day', xp_cost: 300 },
  { title: 'Workout Gear', xp_cost: 400 }
];

type Client = ReturnType<typeof getSupabaseClient>;

const isMissingTableError = (error: PostgrestError | null): boolean =>
  Boolean(error?.code === '42P01' || error?.message?.toLowerCase().includes('does not exist'));

export async function seedDefaultRewardsIfEmpty(userId: string | null, client: Client = getSupabaseClient()): Promise<void> {
  const query = client.from(REWARDS_TABLE).select('id').limit(1);
  if (userId) {
    query.eq('user_id', userId);
  } else {
    query.is('user_id', null);
  }
  const { data, error } = await query;
  if (error) {
    if (isMissingTableError(error)) {
      console.warn({ scope: 'rewards', event: 'missing_table', userId, error });
      return;
    }
    console.error({ scope: 'rewards', event: 'seed_check_error', userId, error });
    throw new Error(`Failed to check rewards: ${error.message}`);
  }
  if (data && data.length > 0) return;

  const payload = defaultRewards.map((r) => ({ ...r, user_id: userId, is_active: true }));

  const { error: insertError } = await client.from(REWARDS_TABLE).insert(payload);
  if (insertError) {
    if (isMissingTableError(insertError)) {
      console.warn({ scope: 'rewards', event: 'missing_table', userId, error: insertError });
      return;
    }
    console.error({ scope: 'rewards', event: 'seed_insert_error', userId, error: insertError });
    throw new Error(`Failed to seed default rewards: ${insertError.message}`);
  }
  console.log({ scope: 'rewards', event: 'seed_inserted', userId, count: payload.length });
}

export async function listRewards(userId: string | null, client: Client = getSupabaseClient()): Promise<RewardRow[]> {
  const { data, error } = await client
    .from(REWARDS_TABLE)
    .select('*')
    .or(`user_id.eq.${userId ?? ''},user_id.is.null`)
    .eq('is_active', true)
    .order('title', { ascending: true });

  if (error) {
    console.error({ scope: 'rewards', event: 'list_error', userId, error });
    throw new Error(`Failed to list rewards: ${error.message}`);
  }

  return (data as RewardRow[]) ?? [];
}

export async function getRewardById(id: string, client: Client = getSupabaseClient()): Promise<RewardRow | null> {
  const { data, error } = await client.from(REWARDS_TABLE).select('*').eq('id', id).maybeSingle();

  if (error) {
    console.error({ scope: 'rewards', event: 'get_error', rewardId: id, error });
    throw new Error(`Failed to load reward: ${error.message}`);
  }

  return (data as RewardRow | null) ?? null;
}

export async function purchaseReward(
  params: { userId: string; reward: RewardRow },
  client: Client = getSupabaseClient()
): Promise<{ purchaseId: string }> {
  const purchasePayload = {
    user_id: params.userId,
    reward_id: params.reward.id,
    title_snapshot: params.reward.title,
    cost_xp_snapshot: params.reward.xp_cost
  };

  const { data, error } = await client
    .from(PURCHASES_TABLE)
    .insert(purchasePayload)
    .select('id')
    .maybeSingle();

  if (error) {
    console.error({ scope: 'rewards', event: 'purchase_insert_error', payload: purchasePayload, error });
    throw new Error(`Failed to record purchase: ${error.message}`);
  }

  const purchaseId = data?.id as string | undefined;

  try {
    await addXpDelta(
      { userId: params.userId, delta: -params.reward.xp_cost, reason: `purchase:${params.reward.title}`, refType: 'reward', refId: params.reward.id },
      client
    );
  } catch (ledgerError) {
    console.error({
      scope: 'rewards',
      event: 'purchase_ledger_error',
      rewardId: params.reward.id,
      userId: params.userId,
      error: ledgerError
    });
  }

  return { purchaseId: purchaseId ?? '' };
}

import { getSupabaseClient } from '../db';
import type { RewardRow } from '../types/supabase';
import { addXpDelta } from './xpLedger';

const REWARDS_TABLE = 'rewards';
const PURCHASES_TABLE = 'reward_purchases';

const defaultRewards: { title: string; cost_xp: number; sort_order: number }[] = [
  { title: 'Focus Tea', cost_xp: 50, sort_order: 10 },
  { title: 'Pomodoro Break (30 min)', cost_xp: 80, sort_order: 20 },
  { title: 'Movie Ticket', cost_xp: 200, sort_order: 30 },
  { title: 'New Book', cost_xp: 250, sort_order: 40 },
  { title: 'Favorite Snack', cost_xp: 60, sort_order: 50 },
  { title: 'Gaming Hour', cost_xp: 120, sort_order: 60 },
  { title: 'Rest Day', cost_xp: 300, sort_order: 70 },
  { title: 'Workout Gear', cost_xp: 400, sort_order: 80 }
];

type Client = ReturnType<typeof getSupabaseClient>;

export async function seedDefaultRewardsIfEmpty(client: Client = getSupabaseClient()): Promise<void> {
  const { data, error } = await client.from(REWARDS_TABLE).select('id').limit(1);
  if (error) {
    console.error({ scope: 'rewards', event: 'seed_check_error', error });
    throw new Error(`Failed to check rewards: ${error.message}`);
  }
  if (data && data.length > 0) return;

  const { error: insertError } = await client.from(REWARDS_TABLE).insert(defaultRewards);
  if (insertError) {
    console.error({ scope: 'rewards', event: 'seed_insert_error', error: insertError });
    throw new Error(`Failed to seed default rewards: ${insertError.message}`);
  }
  console.log({ scope: 'rewards', event: 'seed_inserted', count: defaultRewards.length });
}

export async function listRewards(client: Client = getSupabaseClient()): Promise<RewardRow[]> {
  const { data, error } = await client
    .from(REWARDS_TABLE)
    .select('*')
    .eq('enabled', true)
    .order('sort_order', { ascending: true })
    .order('title', { ascending: true });

  if (error) {
    console.error({ scope: 'rewards', event: 'list_error', error });
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
    cost_xp_snapshot: params.reward.cost_xp
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
      { userId: params.userId, delta: -params.reward.cost_xp, reason: `purchase:${params.reward.title}`, refType: 'reward', refId: params.reward.id },
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

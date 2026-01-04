import { getSupabaseClient } from '../db';
import type { RoutineRow } from '../types/supabase';

const ROUTINES_TABLE = 'routines';

type Client = ReturnType<typeof getSupabaseClient>;

export async function listRoutines(userId: string, client: Client = getSupabaseClient()): Promise<RoutineRow[]> {
  const { data, error } = await client.from(ROUTINES_TABLE).select('*').eq('user_id', userId).order('sort_order', { ascending: true }).order('created_at', { ascending: true });
  if (error) {
    console.error({ scope: 'routines', event: 'list_error', userId, error });
    throw new Error(`Failed to list routines: ${error.message}`);
  }
  return (data as RoutineRow[]) ?? [];
}

export async function getRoutineById(id: string, client: Client = getSupabaseClient()): Promise<RoutineRow | null> {
  const { data, error } = await client.from(ROUTINES_TABLE).select('*').eq('id', id).maybeSingle();
  if (error) {
    console.error({ scope: 'routines', event: 'get_error', id, error });
    throw new Error(`Failed to load routine: ${error.message}`);
  }
  return (data as RoutineRow | null) ?? null;
}

export type RoutineInput = {
  userId: string;
  title: string;
  description?: string | null;
  routineType: 'boolean' | 'duration_minutes' | 'number';
  xpMode: 'fixed' | 'per_minute' | 'per_number' | 'none';
  xpValue?: number | null;
  xpMaxPerDay?: number | null;
  isActive?: boolean;
  sortOrder?: number;
};

export async function createRoutine(input: RoutineInput, client: Client = getSupabaseClient()): Promise<RoutineRow> {
  const payload = {
    user_id: input.userId,
    title: input.title,
    description: input.description ?? null,
    routine_type: input.routineType,
    xp_mode: input.xpMode,
    xp_value: input.xpValue ?? null,
    xp_max_per_day: input.xpMaxPerDay ?? null,
    is_active: input.isActive ?? true,
    sort_order: input.sortOrder ?? 0
  };

  const { data, error } = await client.from(ROUTINES_TABLE).insert(payload).select('*').single();
  if (error || !data) {
    console.error({ scope: 'routines', event: 'create_error', payload, error });
    throw new Error(`Failed to create routine: ${error?.message}`);
  }
  return data as RoutineRow;
}

export async function updateRoutine(
  id: string,
  patch: Partial<Omit<RoutineInput, 'userId' | 'routineType' | 'xpMode'>> & Partial<Pick<RoutineInput, 'xpMode' | 'routineType'>>,
  client: Client = getSupabaseClient()
): Promise<RoutineRow> {
  const payload = {
    ...(patch.title ? { title: patch.title } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.routineType ? { routine_type: patch.routineType } : {}),
    ...(patch.xpMode ? { xp_mode: patch.xpMode } : {}),
    ...(patch.xpValue !== undefined ? { xp_value: patch.xpValue } : {}),
    ...(patch.xpMaxPerDay !== undefined ? { xp_max_per_day: patch.xpMaxPerDay } : {}),
    ...(patch.isActive !== undefined ? { is_active: patch.isActive } : {}),
    ...(patch.sortOrder !== undefined ? { sort_order: patch.sortOrder } : {}),
    updated_at: new Date().toISOString()
  };

  const { data, error } = await client.from(ROUTINES_TABLE).update(payload).eq('id', id).select('*').maybeSingle();
  if (error || !data) {
    console.error({ scope: 'routines', event: 'update_error', id, patch, error });
    throw new Error(`Failed to update routine: ${error?.message}`);
  }
  return data as RoutineRow;
}

export async function deleteRoutine(id: string, client: Client = getSupabaseClient()): Promise<void> {
  const { error } = await client.from(ROUTINES_TABLE).delete().eq('id', id);
  if (error) {
    console.error({ scope: 'routines', event: 'delete_error', id, error });
    throw new Error(`Failed to delete routine: ${error.message}`);
  }
}

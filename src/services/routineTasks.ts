import { getSupabaseClient } from '../db';
import type { RoutineTaskRow } from '../types/supabase';

const ROUTINE_TASKS_TABLE = 'routine_tasks';

type Client = ReturnType<typeof getSupabaseClient>;

export type RoutineTaskInput = {
  routineId: string;
  title: string;
  description?: string | null;
  itemType: RoutineTaskRow['item_type'];
  xpMode: RoutineTaskRow['xp_mode'];
  xpValue?: number | null;
  xpMaxPerDay?: number | null;
  optionsJson?: Record<string, unknown> | null;
  sortOrder?: number;
};

export async function listRoutineTasks(routineId: string, client: Client = getSupabaseClient()): Promise<RoutineTaskRow[]> {
  const { data, error } = await client
    .from(ROUTINE_TASKS_TABLE)
    .select('*')
    .eq('routine_id', routineId)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });

  if (error) {
    console.error({ scope: 'routine_tasks', event: 'list_error', routineId, error });
    throw new Error(`Failed to list routine tasks: ${error.message}`);
  }

  return (data as RoutineTaskRow[]) ?? [];
}

export async function listRoutineTasksByRoutineIds(
  routineIds: string[],
  client: Client = getSupabaseClient()
): Promise<Map<string, RoutineTaskRow[]>> {
  if (routineIds.length === 0) return new Map();
  const { data, error } = await client
    .from(ROUTINE_TASKS_TABLE)
    .select('*')
    .in('routine_id', routineIds)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) {
    console.error({ scope: 'routine_tasks', event: 'list_many_error', routineIds, error });
    throw new Error(`Failed to list routine tasks: ${error.message}`);
  }
  const map = new Map<string, RoutineTaskRow[]>();
  (data as RoutineTaskRow[] | null)?.forEach((task) => {
    const existing = map.get(task.routine_id) ?? [];
    existing.push(task);
    map.set(task.routine_id, existing);
  });
  return map;
}

export async function getRoutineTaskById(id: string, client: Client = getSupabaseClient()): Promise<RoutineTaskRow | null> {
  const { data, error } = await client.from(ROUTINE_TASKS_TABLE).select('*').eq('id', id).maybeSingle();
  if (error) {
    console.error({ scope: 'routine_tasks', event: 'get_error', id, error });
    throw new Error(`Failed to load routine task: ${error.message}`);
  }
  return (data as RoutineTaskRow | null) ?? null;
}

export async function createRoutineTask(input: RoutineTaskInput, client: Client = getSupabaseClient()): Promise<RoutineTaskRow> {
  const payload = {
    routine_id: input.routineId,
    title: input.title,
    description: input.description ?? null,
    item_type: input.itemType,
    xp_mode: input.xpMode,
    xp_value: input.xpValue ?? null,
    xp_max_per_day: input.xpMaxPerDay ?? null,
    options_json: input.optionsJson ?? {},
    sort_order: input.sortOrder ?? 1000
  };

  const { data, error } = await client.from(ROUTINE_TASKS_TABLE).insert(payload).select('*').single();
  if (error || !data) {
    console.error({ scope: 'routine_tasks', event: 'create_error', payload, error });
    throw new Error(`Failed to create routine task: ${error?.message}`);
  }
  return data as RoutineTaskRow;
}

export async function updateRoutineTask(
  id: string,
  patch: Partial<Omit<RoutineTaskInput, 'routineId'>> & { routineId?: string },
  client: Client = getSupabaseClient()
): Promise<RoutineTaskRow> {
  const payload = {
    ...(patch.routineId ? { routine_id: patch.routineId } : {}),
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.itemType ? { item_type: patch.itemType } : {}),
    ...(patch.xpMode ? { xp_mode: patch.xpMode } : {}),
    ...(patch.xpValue !== undefined ? { xp_value: patch.xpValue } : {}),
    ...(patch.xpMaxPerDay !== undefined ? { xp_max_per_day: patch.xpMaxPerDay } : {}),
    ...(patch.optionsJson !== undefined ? { options_json: patch.optionsJson ?? {} } : {}),
    ...(patch.sortOrder !== undefined ? { sort_order: patch.sortOrder } : {}),
    updated_at: new Date().toISOString()
  };

  const { data, error } = await client.from(ROUTINE_TASKS_TABLE).update(payload).eq('id', id).select('*').maybeSingle();
  if (error || !data) {
    console.error({ scope: 'routine_tasks', event: 'update_error', id, patch, error });
    throw new Error(`Failed to update routine task: ${error?.message}`);
  }
  return data as RoutineTaskRow;
}

export async function deleteRoutineTask(id: string, client: Client = getSupabaseClient()): Promise<void> {
  const { error } = await client.from(ROUTINE_TASKS_TABLE).delete().eq('id', id);
  if (error) {
    console.error({ scope: 'routine_tasks', event: 'delete_error', id, error });
    throw new Error(`Failed to delete routine task: ${error.message}`);
  }
}

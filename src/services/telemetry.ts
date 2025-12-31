import { getSupabaseClient } from '../db';
import type { Database } from '../types/supabase';

export type TraceEvent = {
  trace_id?: string;
  event_name: string;
  screen?: string | null;
  payload?: Record<string, unknown> | null;
  timestamp: string;
};

const TELEMETRY_TABLE = 'telemetry_events';

export const isTelemetryEnabled = (settingsJson?: Record<string, unknown>): boolean => {
  const telemetry = (settingsJson as { telemetry?: { enabled?: boolean } } | undefined)?.telemetry;
  if (typeof telemetry?.enabled === 'boolean') return telemetry.enabled;
  return true;
};

export async function logTelemetryEvent(params: {
  userId: string;
  traceId: string;
  eventName: string;
  screen?: string | null;
  payload?: Record<string, unknown> | null;
  enabled: boolean;
}): Promise<void> {
  if (!params.enabled) return;

  const client = getSupabaseClient();
  const row: Database['public']['Tables'][typeof TELEMETRY_TABLE]['Insert'] = {
    user_id: params.userId,
    trace_id: params.traceId,
    event_name: params.eventName,
    screen: params.screen ?? null,
    payload: params.payload ?? null
  };

  const { error } = await client.from(TELEMETRY_TABLE).insert(row);
  if (error) {
    console.warn({ scope: 'telemetry', event: 'log_failed', error, traceId: params.traceId, eventName: params.eventName });
  }
}

export async function getRecentTelemetryEvents(userId: string, limit = 20): Promise<TraceEvent[]> {
  const client = getSupabaseClient();
  const { data, error } = await client
    .from(TELEMETRY_TABLE)
    .select('trace_id,event_name,screen,payload,created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error || !data) {
    console.warn({ scope: 'telemetry', event: 'recent_events_failed', userId, error });
    return [];
  }

  return data.map((row) => ({
    trace_id: row.trace_id,
    event_name: row.event_name,
    screen: row.screen,
    payload: row.payload as Record<string, unknown> | null,
    timestamp: row.created_at
  })) as unknown as TraceEvent[];
}

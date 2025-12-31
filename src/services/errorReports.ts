import crypto from 'crypto';
import { getSupabaseClient } from '../db';
import type { Database, ErrorReportRow } from '../types/supabase';

const ERROR_REPORTS_TABLE = 'error_reports';

const serializeError = (error: unknown): Record<string, unknown> => {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack ?? null
    };
  }
  if (typeof error === 'object' && error !== null) {
    return { ...(error as Record<string, unknown>) };
  }
  return { message: String(error) };
};

export async function logErrorReport(params: {
  userId?: string;
  traceId: string;
  errorCode: string;
  error: unknown;
  recentEvents?: Record<string, unknown>[] | null;
}): Promise<void> {
  if (!params.userId) {
    console.warn({ scope: 'error_reports', event: 'skip_no_user', traceId: params.traceId, errorCode: params.errorCode });
    return;
  }

  const client = getSupabaseClient();
  const row: Database['public']['Tables'][typeof ERROR_REPORTS_TABLE]['Insert'] = {
    id: crypto.randomUUID(),
    user_id: params.userId,
    trace_id: params.traceId,
    error_code: params.errorCode,
    error_json: serializeError(params.error),
    recent_events: (params.recentEvents ?? []) as unknown as Record<string, unknown>
  };

  const { error } = await client.from(ERROR_REPORTS_TABLE).insert(row);
  if (error) {
    console.error({ scope: 'error_reports', event: 'insert_failed', error, traceId: params.traceId, errorCode: params.errorCode });
  }
}

export async function getErrorReportByCode(errorCode: string): Promise<ErrorReportRow | null> {
  const client = getSupabaseClient();
  const { data, error } = await client
    .from(ERROR_REPORTS_TABLE)
    .select('*')
    .eq('error_code', errorCode)
    .maybeSingle();

  if (error) {
    console.error({ scope: 'error_reports', event: 'fetch_failed', errorCode, error });
    return null;
  }

  return (data as ErrorReportRow | null) ?? null;
}

import { config } from '../config';
import type { LogLevel } from '../utils/logger';
import { safeTruncate } from '../utils/safe_truncate';

type ReporterContext = Record<string, unknown>;

type ReportOptions = {
  stack?: string;
  context?: ReporterContext;
};

type LogReporter = {
  report: (level: LogLevel, message: string, opts?: ReportOptions) => Promise<void>;
};

type ReporterConfig = {
  enabled: boolean;
  levels: Set<LogLevel>;
  ingestUrl?: string;
  ingestKey?: string;
  projectId?: string;
  serviceName: string;
  env: string;
};

const LEVELS: LogLevel[] = ['error', 'warn', 'info'];
const DEFAULT_LEVELS: LogLevel[] = ['error'];
const SENSITIVE_KEYS = ['token', 'secret', 'password', 'key', 'authorization', 'auth', 'cookie', 'set-cookie'];
const REDACT_KEYS = ['text', 'message', 'caption'];

let reporter: LogReporter | null = null;

const parseLevels = (value: string | undefined): Set<LogLevel> => {
  if (!value) return new Set(DEFAULT_LEVELS);
  const tokens = value
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
  const levels = tokens.filter((token): token is LogLevel => LEVELS.includes(token as LogLevel));
  return levels.length ? new Set(levels) : new Set(DEFAULT_LEVELS);
};

const buildReporterConfig = (): ReporterConfig => {
  const { logReporter } = config;
  return {
    enabled: logReporter.enabled,
    levels: parseLevels(logReporter.levels),
    ingestUrl: logReporter.ingestUrl,
    ingestKey: logReporter.ingestKey,
    projectId: logReporter.projectId,
    serviceName: logReporter.serviceName,
    env: logReporter.env
  };
};

const shouldRedactKey = (key: string): boolean => {
  const lowered = key.toLowerCase();
  return (
    SENSITIVE_KEYS.some((needle) => lowered.includes(needle)) ||
    REDACT_KEYS.some((needle) => lowered === needle)
  );
};

const sanitizeContextValue = (value: unknown, depth: number): unknown => {
  if (depth > 6) return '[Truncated]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return safeTruncate(value, 500);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((entry) => sanitizeContextValue(entry, depth + 1));
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (shouldRedactKey(key)) {
        result[key] = '[REDACTED]';
      } else {
        result[key] = sanitizeContextValue(entry, depth + 1);
      }
    }
    return result;
  }
  return String(value);
};

const sanitizeContext = (context?: ReporterContext): ReporterContext | undefined => {
  if (!context) return undefined;
  const sanitized = sanitizeContextValue(context, 0) as ReporterContext;
  try {
    JSON.stringify(sanitized);
    return sanitized;
  } catch {
    return undefined;
  }
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const buildPayload = (params: {
  config: ReporterConfig;
  level: LogLevel;
  message: string;
  stack?: string;
  context?: ReporterContext;
}): Record<string, unknown> => {
  return {
    projectId: params.config.projectId,
    service: params.config.serviceName,
    env: params.config.env,
    level: params.level,
    timestamp: new Date().toISOString(),
    message: safeTruncate(params.message, 1000),
    stack: params.stack ? safeTruncate(params.stack, 3000) : undefined,
    context: sanitizeContext(params.context)
  };
};

const buildIngestUrl = (configValues: ReporterConfig): string | null => {
  if (!configValues.ingestUrl || !configValues.ingestKey) return null;
  const url = new URL(configValues.ingestUrl);
  url.searchParams.set('key', configValues.ingestKey);
  return url.toString();
};

export const initLogReporter = (): LogReporter => {
  if (reporter) return reporter;

  const configValues = buildReporterConfig();
  let inReporter = false;
  let circuitUntil = 0;
  let lastWarnAt = 0;

  const report: LogReporter['report'] = async (level, message, opts) => {
    if (!configValues.enabled) return;
    if (!configValues.levels.has(level)) return;
    if (Date.now() < circuitUntil) return;
    if (inReporter) return;

    const ingestUrl = buildIngestUrl(configValues);
    if (!ingestUrl || !configValues.projectId) return;

    inReporter = true;
    const payload = buildPayload({
      config: configValues,
      level,
      message,
      stack: opts?.stack,
      context: opts?.context
    });

    const backoffSeconds = [1000, 2000, 5000, 10000];
    let lastError: unknown = null;

    try {
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        if (attempt > 1) {
          const delay = backoffSeconds[Math.min(attempt - 2, backoffSeconds.length - 1)];
          await sleep(delay);
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 4000);

        try {
          const response = await fetch(ingestUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: controller.signal
          });

          if (response.ok) return;
          lastError = new Error(`Log ingest returned ${response.status}`);
        } catch (error) {
          lastError = error;
        } finally {
          clearTimeout(timeout);
        }
      }
    } finally {
      inReporter = false;
    }

    circuitUntil = Date.now() + 30_000;
    if (Date.now() - lastWarnAt > 60_000) {
      const messageText = lastError instanceof Error ? lastError.message : String(lastError);
      console.warn('[log-reporter] Failed to send log to Path Applier.', messageText);
      lastWarnAt = Date.now();
    }
  };

  reporter = { report };
  return reporter;
};

export const getLogReporter = (): LogReporter | null => reporter;

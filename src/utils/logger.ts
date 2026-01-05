export type LogLevel = 'info' | 'warn' | 'error';

export interface LogMeta {
  [key: string]: unknown;
}

export interface LogEvent {
  level: LogLevel;
  message: string;
  meta?: LogMeta;
  timestamp: string;
  projectId: string;
  env?: string;
}

const projectId = 'daily-system';
const endpoint = process.env.PATH_APPLIER_LOG_URL;
const minLevelRaw = process.env.PATH_APPLIER_LOG_MIN_LEVEL;

const isLogLevel = (value: string | undefined): value is LogLevel => {
  return value === 'info' || value === 'warn' || value === 'error';
};

const minLevel: LogLevel = isLogLevel(minLevelRaw) ? minLevelRaw : 'error';

export const levelToNumber = (level: LogLevel): number => {
  switch (level) {
    case 'info':
      return 10;
    case 'warn':
      return 20;
    case 'error':
      return 30;
  }
};

const minLevelNumber = levelToNumber(minLevel);

const sendRemoteLog = async (event: LogEvent): Promise<void> => {
  if (!endpoint) return;

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event)
    });

    if (res.status >= 400) {
      console.error(`[LOGGER] Failed to send log to Path Applier: ${res.status} ${res.statusText}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[LOGGER] Failed to send log to Path Applier:', message);
  }
};

const logWithLevel = (level: LogLevel, message: string, meta?: LogMeta): void => {
  const prefix = level.toUpperCase();
  const logMessage = `[${prefix}] ${message}`;

  if (meta) {
    if (level === 'info') {
      console.log(logMessage, meta);
    } else if (level === 'warn') {
      console.warn(logMessage, meta);
    } else {
      console.error(logMessage, meta);
    }
  } else {
    if (level === 'info') {
      console.log(logMessage);
    } else if (level === 'warn') {
      console.warn(logMessage);
    } else {
      console.error(logMessage);
    }
  }

  if (!endpoint) return;
  if (levelToNumber(level) < minLevelNumber) return;

  const event: LogEvent = {
    level,
    message,
    meta,
    timestamp: new Date().toISOString(),
    projectId,
    env: process.env.NODE_ENV
  };

  void sendRemoteLog(event);
};

export const logInfo = (message: string, meta?: LogMeta): void => {
  logWithLevel('info', message, meta);
};

export const logWarn = (message: string, meta?: LogMeta): void => {
  logWithLevel('warn', message, meta);
};

export const logError = (message: string, meta?: LogMeta): void => {
  logWithLevel('error', message, meta);
};

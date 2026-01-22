import { config } from '../config';

const DEFAULT_TIMEZONE = config.defaultTimezone;

export type LocalTime = {
  date: string;
  time: string;
  timezone: string;
};

const buildFormatter = (timezone: string): Intl.DateTimeFormat =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  });

const extractParts = (formatter: Intl.DateTimeFormat, date: Date): LocalTime => {
  const parts = formatter.formatToParts(date);
  const lookup: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      lookup[part.type] = part.value;
    }
  }

  return {
    date: `${lookup.year}-${lookup.month}-${lookup.day}`,
    time: `${lookup.hour}:${lookup.minute}`,
    timezone: formatter.resolvedOptions().timeZone ?? DEFAULT_TIMEZONE,
  };
};

const normalizeTimezone = (timezone?: string | null): string => {
  const tz = timezone?.trim();
  return tz && tz.length > 0 ? tz : DEFAULT_TIMEZONE;
};

export function formatLocalTime(timezone?: string | null): LocalTime {
  const tz = normalizeTimezone(timezone);
  const formatter = buildFormatter(tz);
  return extractParts(formatter, new Date());
}

// Format a specific UTC instant (ISO string) into user-local time.
export function formatInstantToLocal(isoUtc: string, timezone?: string | null): LocalTime {
  const tz = normalizeTimezone(timezone);
  const formatter = buildFormatter(tz);
  const date = new Date(isoUtc);
  return extractParts(formatter, date);
}

export function localDateTimeToUtcIso(localDate: string, localTime: string, timezone?: string | null): string {
  const tz = normalizeTimezone(timezone);
  const [year, month, day] = localDate.split('-').map(Number);
  const [hour, minute] = localTime.split(':').map(Number);

  const baseUtc = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const formatter = buildFormatter(tz);
  const observed = extractParts(formatter, baseUtc);

  const [obsYear, obsMonth, obsDay] = observed.date.split('-').map(Number);
  const [obsHour, obsMinute] = observed.time.split(':').map(Number);

  const intendedUtc = Date.UTC(year, month - 1, day, hour, minute);
  const observedUtc = Date.UTC(obsYear, obsMonth - 1, obsDay, obsHour, obsMinute);

  const offsetMs = observedUtc - intendedUtc;
  const adjusted = new Date(baseUtc.getTime() - offsetMs);
  return adjusted.toISOString();
}

const CLOCK_EMOJIS = ['🕛', '🕧', '🕐', '🕜', '🕑', '🕝', '🕒', '🕞', '🕓', '🕟', '🕔', '🕠', '🕕', '🕡', '🕖', '🕢', '🕗', '🕣', '🕘', '🕤', '🕙', '🕥', '🕚', '🕦'] as const;

export function getClockEmojiForTime(time?: string | null): string {
  if (!time) return '🕒';
  const [hhRaw, mmRaw] = time.split(':');
  const hh = Number(hhRaw);
  const mm = Number(mmRaw);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return '🕒';
  const minutes = hh * 60 + mm;
  if (minutes < 0 || minutes >= 24 * 60) return '🕒';
  const index = Math.round(minutes / 30) % CLOCK_EMOJIS.length;
  return CLOCK_EMOJIS[index] ?? '🕒';
}

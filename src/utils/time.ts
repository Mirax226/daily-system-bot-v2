const DEFAULT_TIMEZONE = 'Asia/Tehran';

export type LocalTime = {
  date: string;
  time: string;
  timezone: string;
};

const buildFormatter = (timezone: string): Intl.DateTimeFormat => {
  return new Intl.DateTimeFormat('en-IR-u-ca-persian-nu-latn', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
};

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

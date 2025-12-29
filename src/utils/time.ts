const DEFAULT_TIMEZONE = 'Asia/Tehran';

export type LocalTime = {
  date: string;
  time: string;
  timezone: string;
};

export function formatLocalTime(timezone: string | undefined): LocalTime {
  const tz = timezone && timezone.trim().length > 0 ? timezone : DEFAULT_TIMEZONE;
  const now = new Date();

  return formatDateWithTimezone(now, tz);
}

function formatDateWithTimezone(date: Date, timezone: string): LocalTime {
  const formatter = new Intl.DateTimeFormat('en-IR-u-ca-persian-nu-latn', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  });

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
    timezone
  };
}

export function formatInstantToLocal(isoUtc: string, timezone: string | undefined): LocalTime {
  const tz = timezone && timezone.trim().length > 0 ? timezone : DEFAULT_TIMEZONE;
  const date = new Date(isoUtc);
  return formatDateWithTimezone(date, tz);
}

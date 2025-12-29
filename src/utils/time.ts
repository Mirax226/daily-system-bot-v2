const DEFAULT_TIMEZONE = 'Asia/Tehran';

export type LocalTime = {
  date: string;
  time: string;
  timezone: string;
};

export function formatLocalTime(timezone: string | undefined): LocalTime {
  const tz = timezone && timezone.trim().length > 0 ? timezone : DEFAULT_TIMEZONE;
  const now = new Date();

  const formatter = new Intl.DateTimeFormat('en-IR-u-ca-persian-nu-latn', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  });

  const parts = formatter.formatToParts(now);
  const lookup: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      lookup[part.type] = part.value;
    }
  }

  return {
    date: `${lookup.year}-${lookup.month}-${lookup.day}`,
    time: `${lookup.hour}:${lookup.minute}`,
    timezone: tz
  };
}

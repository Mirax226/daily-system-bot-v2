import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from '../config';

export const EMOJI = {
  menu: '📋',
  back: '⬅️',
  delete: '🗑️',
  edit: '✏️',
  attach: '📎',
  confirm: '✅',
  cancel: '❌',
  warning: '⚠️',
  info: 'ℹ️',
  success: '✅',
  notes: '🗒️',
  noteDetails: '🗒️',
  reminders: '⏰',
  reminder: '⏰',
  history: '📜',
  settings: '⚙️',
  photo: '🖼️',
  video: '🎥',
  voice: '🎙️',
  file: '📄',
  video_note: '📹',
  document: '📄',
  calendar: '📅',
  clock: '🕒',
  new: '➕',
  toggleOn: '✅',
  toggleOff: '🚫',
  save: '✅',
  ok: '✅',
  processing: '⏳',
  archive: '🗂️',
  title: '🏷️',
  description: '📝',
  user: '👤',
  id: '🆔',
  type: '🧩',
  items: '📎',
  view: '👀'
} as const;

const CLOCK_HOURS = ['🕛', '🕐', '🕑', '🕒', '🕓', '🕔', '🕕', '🕖', '🕗', '🕘', '🕙', '🕚'] as const;
const CLOCK_HALVES = ['🕧', '🕜', '🕝', '🕞', '🕟', '🕠', '🕡', '🕢', '🕣', '🕤', '🕥', '🕦'] as const;

export type EmojiKey = keyof typeof EMOJI;

type EmojiContext = { enabled: boolean };

const emojiContext = new AsyncLocalStorage<EmojiContext>();

export const runWithEmojiSetting = async (enabled: boolean, handler: () => Promise<void>): Promise<void> => {
  return await new Promise<void>((resolve, reject) => {
    emojiContext.run({ enabled }, async () => {
      try {
        await handler();
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
};

export const isEmojiEnabled = (): boolean => {
  const stored = emojiContext.getStore();
  if (stored) return stored.enabled;
  return config.ui?.emojiEnabled !== false;
};

export function emoji(key: EmojiKey): string {
  return EMOJI[key];
}

export function withEmoji(key: EmojiKey, text: string): string {
  if (!isEmojiEnabled()) return text;
  return `${EMOJI[key]} ${text}`.trim();
}

export function btn(key: EmojiKey, text: string): string {
  return withEmoji(key, text);
}

export function clockEmojiFromTime(hhmm: string): string {
  const [hhRaw, mmRaw] = hhmm.split(':');
  const hh = Number(hhRaw);
  const mm = Number(mmRaw);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return EMOJI.clock;

  const normalizedHour = ((Math.floor(hh) % 24) + 24) % 24;
  const normalizedMinute = ((Math.floor(mm) % 60) + 60) % 60;

  const rounded = normalizedMinute <= 14 ? 0 : normalizedMinute <= 44 ? 30 : 60;
  let hour12 = normalizedHour % 12;
  if (rounded === 60) {
    hour12 = (hour12 + 1) % 12;
  }
  const hourIndex = hour12 === 0 ? 0 : hour12;
  return rounded === 30 ? CLOCK_HALVES[hourIndex] : CLOCK_HOURS[hourIndex];
}

export function clockEmojiFromDate(date: Date): string {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return EMOJI.clock;
  const hh = date.getHours();
  const mm = date.getMinutes();
  const hhmm = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  return clockEmojiFromTime(hhmm);
}

export function clockEmojiByTime(hh: number, mm: number): string {
  const hhmm = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  return clockEmojiFromTime(hhmm);
}

export function label(icon: string, text: string): string {
  if (!isEmojiEnabled()) return text;
  return `${icon} ${text}`.trim();
}

export function title(icon: string, text: string): string {
  return label(icon, text);
}

export const emojiMap = EMOJI;

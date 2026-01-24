const EMOJI = {
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
  reminders: '⏰',
  history: '📜',
  settings: '⚙️',
  photo: '🖼️',
  video: '🎞️',
  voice: '🎤',
  file: '📄',
  video_note: '📹',
  document: '📄'
} as const;

const CLOCK_HOURS = ['🕛', '🕐', '🕑', '🕒', '🕓', '🕔', '🕕', '🕖', '🕗', '🕘', '🕙', '🕚'] as const;
const CLOCK_HALVES = ['🕧', '🕜', '🕝', '🕞', '🕟', '🕠', '🕡', '🕢', '🕣', '🕤', '🕥', '🕦'] as const;

export type EmojiKey = keyof typeof EMOJI;

export function emoji(key: EmojiKey): string {
  return EMOJI[key];
}

export function clockEmojiByTime(hh: number, mm: number): string {
  const normalizedHour = ((Math.floor(hh) % 24) + 24) % 24;
  const normalizedMinute = ((Math.floor(mm) % 60) + 60) % 60;

  let hour12 = normalizedHour % 12;
  const rounded = normalizedMinute <= 14 ? 0 : normalizedMinute <= 44 ? 30 : 60;
  if (rounded === 60) {
    hour12 = (hour12 + 1) % 12;
  }
  const hourIndex = hour12 === 0 ? 0 : hour12;
  return rounded === 30 ? CLOCK_HALVES[hourIndex] : CLOCK_HOURS[hourIndex];
}

export function label(icon: string, text: string): string {
  return `${icon} ${text}`.trim();
}

export function title(icon: string, text: string): string {
  return `${icon} ${text}`.trim();
}

export const emojiMap = EMOJI;

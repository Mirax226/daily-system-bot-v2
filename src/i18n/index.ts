import en from './en.json';
import fa from './fa.json';

type Messages = typeof en;

const messages = {
  en,
  fa
};

export function t(key: string, params?: Record<string, string | number>, locale: keyof typeof messages = 'en'): string {
  const parts = key.split('.');
  let current: any = messages[locale];

  for (const part of parts) {
    if (!current[part]) return key;
    current = current[part];
  }

  let result = String(current);

  if (params) {
    for (const [k, v] of Object.entries(params)) {
      result = result.replace(new RegExp(`{${k}}`, 'g'), String(v));
    }
  }

  return result;
}

export type { Messages };

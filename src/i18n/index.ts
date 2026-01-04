import { AsyncLocalStorage } from 'async_hooks';
import en from './en.json';
import fa from './fa.json';

type Messages = typeof en;

const messages = {
  en,
  fa
};

export type Locale = keyof typeof messages;

const localeStore = new AsyncLocalStorage<{ locale: Locale }>();

const getStoredLocale = (): Locale | null => localeStore.getStore()?.locale ?? null;

export const resolveLocale = (candidate?: string | null): Locale => (candidate === 'fa' ? 'fa' : 'en');

export const withLocale = async <T>(locale: Locale, fn: () => Promise<T> | T): Promise<T> => {
  return await localeStore.run({ locale }, fn);
};

export function t(key: string, params?: Record<string, string | number>, locale: Locale = getStoredLocale() ?? 'en'): string {
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

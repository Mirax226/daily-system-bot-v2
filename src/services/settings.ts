import { queryDb } from '../db';

const SETTINGS_TABLE = 'user_settings_kv';
const CACHE_TTL_MS = 30_000;

const cache = new Map<string, { value: string | null; expiresAt: number }>();

const buildCacheKey = (userId: string, key: string): string => `${userId}:${key}`;

const parseBoolean = (value: string | null | undefined): boolean | null => {
  if (value === null || value === undefined) return null;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  return null;
};

export const getUserSetting = async (userId: string, key: string): Promise<string | null> => {
  const cacheKey = buildCacheKey(userId, key);
  const now = Date.now();
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const { rows } = await queryDb<{ value: string | null }>(
    `select value from public.${SETTINGS_TABLE} where user_id = $1 and key = $2 limit 1`,
    [userId, key]
  );
  const value = rows?.[0]?.value ?? null;
  cache.set(cacheKey, { value, expiresAt: now + CACHE_TTL_MS });
  return value;
};

export const setUserSetting = async (userId: string, key: string, value: string | null): Promise<void> => {
  const cacheKey = buildCacheKey(userId, key);
  await queryDb(
    `
      insert into public.${SETTINGS_TABLE} (user_id, key, value, updated_at)
      values ($1, $2, $3, now())
      on conflict (user_id, key)
      do update set value = excluded.value, updated_at = now()
    `,
    [userId, key, value]
  );
  cache.set(cacheKey, { value, expiresAt: Date.now() + CACHE_TTL_MS });
};

export const getUserBooleanSetting = async (
  userId: string,
  key: string,
  fallback: boolean
): Promise<boolean> => {
  const raw = await getUserSetting(userId, key);
  const parsed = parseBoolean(raw);
  return parsed ?? fallback;
};

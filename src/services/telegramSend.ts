import { GrammyError } from 'grammy';

type RateLimitError = {
  kind: 'rate_limit';
  retryAfterSeconds: number;
};

type TelegramError = {
  kind: 'telegram_error';
  message: string;
  code?: number;
};

export type TelegramSendFailure = RateLimitError | TelegramError;

const parseRetryAfterSeconds = (error: GrammyError): number | null => {
  const retryAfter = error.parameters?.retry_after;
  if (typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter > 0) {
    return retryAfter;
  }

  const description = error.description ?? '';
  const match = description.match(/retry after (\d+)/i);
  if (match) {
    const seconds = Number(match[1]);
    if (Number.isFinite(seconds) && seconds > 0) {
      return seconds;
    }
  }

  return null;
};

export const parseTelegramError = (error: unknown): TelegramSendFailure => {
  if (error instanceof GrammyError) {
    const grammyError = error as GrammyError;
    if (grammyError.error_code === 429) {
      const retryAfterSeconds = parseRetryAfterSeconds(grammyError) ?? 30;
      return { kind: 'rate_limit', retryAfterSeconds };
    }

    return {
      kind: 'telegram_error',
      message: grammyError.description || grammyError.message,
      code: grammyError.error_code
    };
  }

  if (typeof error === 'object' && error !== null && 'error_code' in error) {
    const errorCode = (error as { error_code?: number }).error_code;
    const message = (error as { description?: string }).description ?? 'Telegram error';
    if (errorCode === 429) {
      return { kind: 'rate_limit', retryAfterSeconds: 30 };
    }

    return { kind: 'telegram_error', message, code: errorCode };
  }

  const message = error instanceof Error ? error.message : String(error);
  return { kind: 'telegram_error', message };
};

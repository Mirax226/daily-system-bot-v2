import { schemaSync } from './schemaSync';
import { logError, logInfo } from '../utils/logger';

const run = async (): Promise<void> => {
  try {
    const result = await schemaSync();
    logInfo('Schema sync finished', {
      scope: 'schemaSync',
      applied_count: result.appliedCount,
      skipped_count: result.skippedCount,
      duration_ms: result.durationMs
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logError('Schema sync failed', { scope: 'schemaSync', error: message });
    process.exit(1);
  }
};

void run();

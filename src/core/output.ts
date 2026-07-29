export interface SkipStats {
  skipped: number;
  skippedReasons: Record<string, number>;
}

export function createSkipStats(): SkipStats {
  return { skipped: 0, skippedReasons: {} };
}

export function markSkipped(stats: SkipStats, reason: string): void {
  stats.skipped++;
  stats.skippedReasons[reason] = (stats.skippedReasons[reason] || 0) + 1;
}

export function formatReasons(reasons: Record<string, number>): string {
  return Object.entries(reasons)
    .map(([reason, count]) => `${reason}: ${count}`)
    .join(', ');
}

export function assertWithinOutputLimit(
  outputLength: number,
  maxOutputChars: number,
  message: string,
): void {
  if (Number.isFinite(maxOutputChars) && maxOutputChars > 0 && outputLength > maxOutputChars) {
    throw new OutputLimitError(message);
  }
}

export class OutputLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutputLimitError';
  }
}

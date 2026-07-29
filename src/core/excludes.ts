import micromatch from 'micromatch';
import { toPosixPath } from './paths';

function hasGlobMeta(pattern: string): boolean {
  return /[*?[{]/.test(pattern);
}

/**
 * Exclude matching with strict semantics:
 * - Plain names (no `/`, no glob meta) match a complete path segment only.
 *   `package-lock.json` matches `.../package-lock.json` but not `my-package-lock.json.bak`.
 * - Glob patterns match the full POSIX path (and basename when the pattern has no `/`),
 *   using micromatch with explicit anchoring (no substring regex).
 */
export function shouldExclude(filePath: string, patterns: readonly string[] | undefined): boolean {
  const p = toPosixPath(filePath);
  const segments = p.split('/').filter((s) => s.length > 0);
  const base = segments[segments.length - 1] ?? '';

  for (const pattern of patterns ?? []) {
    const raw = String(pattern || '').trim();
    if (!raw) continue;

    const normalized = toPosixPath(raw);

    if (!hasGlobMeta(normalized) && !normalized.includes('/')) {
      if (segments.includes(normalized)) return true;
      continue;
    }

    try {
      if (micromatch.isMatch(p, normalized, { dot: true })) return true;
      // Patterns without `/` that still contain globs (e.g. `*.lock`) match basename.
      if (!normalized.includes('/') && micromatch.isMatch(base, normalized, { dot: true })) {
        return true;
      }
    } catch {
      // Ignore bad custom pattern.
    }
  }

  return false;
}

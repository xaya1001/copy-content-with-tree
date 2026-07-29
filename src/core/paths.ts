import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Normalize path separators for matching/display.
 * On Windows, convert `\` to `/`. On POSIX, leave `\` intact — it is a legal
 * filename byte and must not be treated as a directory separator.
 */
export function toPosixPath(value: string): string {
  const text = String(value);
  if (process.platform === 'win32') {
    return text.replace(/\\/g, '/');
  }
  return text;
}

/**
 * Canonicalize a filesystem path for identity and containment comparisons.
 *
 * Uses `realpath` on the nearest existing ancestor (so deleted / not-yet-created
 * selections still compare correctly), then appends the missing trailing
 * segments. This collapses macOS `/var` vs `/private/var`, directory symlink
 * aliases, and Windows short/long (8.3) path forms onto one physical path.
 *
 * Does not change user-facing display paths — callers keep the original string
 * for clipboard output and only use this result for comparisons / pathspecs.
 */
export async function canonicalizePath(inputPath: string): Promise<string> {
  const absolute = path.resolve(inputPath);
  const suffixes: string[] = [];
  let cursor = absolute;

  for (;;) {
    try {
      const real = await fs.realpath(cursor);
      return suffixes.length === 0 ? real : path.resolve(real, ...suffixes);
    } catch {
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        return absolute;
      }
      suffixes.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

/** Compare already-resolved paths; Windows equality is case-insensitive. */
export function canonicalPathsEqual(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  if (process.platform === 'win32') {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}

/**
 * Containment check after canonicalizing both sides (symlink aliases, macOS
 * private prefix, Windows short paths).
 */
export async function isCanonicalPathInside(root: string, candidate: string): Promise<boolean> {
  return isPathInside(await canonicalizePath(root), await canonicalizePath(candidate));
}

export async function isCanonicalPathInsideOrEqual(
  root: string,
  candidate: string,
): Promise<boolean> {
  const canonicalRoot = await canonicalizePath(root);
  const canonicalCandidate = await canonicalizePath(candidate);
  return (
    canonicalPathsEqual(canonicalRoot, canonicalCandidate) ||
    isPathInside(canonicalRoot, canonicalCandidate)
  );
}

export function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export function stripLeadingSlashes(value: string): string {
  return value.replace(/^\/+/, '');
}

/** Workspace-relative display path. Never returns an absolute host path. */
export function toDisplayPath(workspaceFolder: string, filePath: string): string {
  const relative = path.relative(workspaceFolder, filePath);
  if (!relative || relative === '') {
    return path.basename(filePath);
  }
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return path.basename(filePath);
  }
  return toPosixPath(relative);
}

export function isPathInside(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  if (canonicalPathsEqual(resolvedRoot, resolvedCandidate)) return true;
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (!relative || path.isAbsolute(relative)) return false;
  // Component-aware: only treat ".." / "../..." as outside. Names like "..foo" are inside.
  return relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

/** True when candidate is root itself or a contained path (component-aware). */
export function isPathInsideOrEqual(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  return canonicalPathsEqual(resolvedRoot, resolvedCandidate) || isPathInside(root, candidate);
}

export function rewritePath(
  inputPath: string,
  fromPrefix: string,
  toPrefix: string,
): string | null {
  const p = toPosixPath(inputPath);
  const from = trimTrailingSlash(toPosixPath(fromPrefix || ''));
  const to = trimTrailingSlash(toPosixPath(toPrefix || ''));
  if (!from || !to) return null;
  if (p === from) return to;
  if (p.startsWith(`${from}/`)) return to + p.slice(from.length);
  return null;
}

export function buildRewriteCandidates(
  absTarget: string,
  pathRewrite: ReadonlyArray<{ from: string; to: string }>,
): string[] {
  const candidates = [toPosixPath(absTarget)];
  const rules = [...pathRewrite].sort((a, b) => b.from.length - a.from.length);
  for (const rule of rules) {
    const rewritten = rewritePath(absTarget, rule.from, rule.to);
    if (rewritten && !candidates.includes(rewritten)) {
      candidates.push(rewritten);
    }
  }
  return candidates;
}

/** Prefer a workspace-relative path for clipboard metadata; never emit raw absolute paths. */
export function toSafePathLabel(absoluteOrRelative: string, roots: readonly string[]): string {
  const posix = toPosixPath(absoluteOrRelative);
  if (!path.isAbsolute(absoluteOrRelative) && !posix.startsWith('/')) {
    return escapePathForDisplay(posix);
  }

  for (const root of roots) {
    if (isPathInsideOrEqual(root, absoluteOrRelative)) {
      const relative = toPosixPath(path.relative(root, absoluteOrRelative));
      if (relative && !relative.startsWith('../') && relative !== '..') {
        return escapePathForDisplay(relative || '.');
      }
      if (relative === '') return '.';
    }
  }

  return escapePathForDisplay(path.posix.basename(posix) || '(external)');
}

/**
 * Escape control characters for tree lines and content headers.
 * Does not alter the underlying filesystem / Git path used for I/O.
 */
export function escapePathForDisplay(value: string): string {
  let out = '';
  for (const ch of String(value)) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '\\') {
      out += '\\\\';
    } else if (ch === '\n') {
      out += '\\n';
    } else if (ch === '\r') {
      out += '\\r';
    } else if (ch === '\t') {
      out += '\\t';
    } else if (code < 0x20 || code === 0x7f) {
      out += `\\x${code.toString(16).padStart(2, '0')}`;
    } else {
      out += ch;
    }
  }
  return out;
}

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  buildRewriteCandidates,
  canonicalizePath,
  canonicalPathsEqual,
  isPathInside,
  toPosixPath,
  toSafePathLabel,
} from '../core/paths';
import type { PathRewriteRule } from '../core/config';

export type ResolvedKind = 'file' | 'directory' | 'missing';

export interface ResolveResult {
  kind: ResolvedKind;
  readPath?: string;
  reason?: string;
  chain: string[];
  external: boolean;
}

export interface SymlinkPolicy {
  followFileSymlinks: boolean;
  allowExternalSymlinkTargets: boolean;
  pathRewrite: readonly PathRewriteRule[];
  /** Absolute roots that count as "inside" for symlink targets (workspace / selection). */
  boundaryRoots: readonly string[];
}

async function isOutsideBoundary(
  resolvedTarget: string,
  boundaryRoots: readonly string[],
): Promise<boolean> {
  const canonicalTarget = await canonicalizePath(resolvedTarget);
  for (const root of boundaryRoots) {
    const canonicalRoot = await canonicalizePath(root);
    if (
      canonicalPathsEqual(canonicalRoot, canonicalTarget) ||
      isPathInside(canonicalRoot, canonicalTarget)
    ) {
      return false;
    }
  }
  return true;
}

export async function resolveReadablePath(
  filePath: string,
  policy: SymlinkPolicy,
  seen = new Set<string>(),
  depth = 0,
): Promise<ResolveResult> {
  const key = toPosixPath(filePath);
  if (seen.has(key)) {
    return { kind: 'missing', reason: 'symlink loop', chain: [], external: false };
  }
  seen.add(key);

  if (depth > 8) {
    return { kind: 'missing', reason: 'symlink depth exceeded', chain: [], external: false };
  }

  try {
    const st = await fs.stat(filePath);
    let resolvedTarget = filePath;
    try {
      resolvedTarget = await fs.realpath(filePath);
    } catch {
      resolvedTarget = filePath;
    }
    const external = await isOutsideBoundary(resolvedTarget, policy.boundaryRoots);
    if (st.isFile()) {
      return { kind: 'file', readPath: resolvedTarget, chain: [], external };
    }
    if (st.isDirectory()) {
      return { kind: 'directory', readPath: resolvedTarget, chain: [], external };
    }
    return { kind: 'missing', reason: 'unsupported target type', chain: [], external };
  } catch {
    // Fall through for broken absolute symlinks that may rewrite.
  }

  let lst;
  try {
    lst = await fs.lstat(filePath);
  } catch {
    return { kind: 'missing', reason: 'path does not exist', chain: [], external: false };
  }

  if (!lst.isSymbolicLink()) {
    return {
      kind: 'missing',
      reason: 'stat failed for non-symlink path',
      chain: [],
      external: false,
    };
  }

  let linkTarget: string;
  try {
    linkTarget = await fs.readlink(filePath);
  } catch {
    return { kind: 'missing', reason: 'readlink failed', chain: [], external: false };
  }

  const absTarget = path.isAbsolute(linkTarget)
    ? linkTarget
    : path.resolve(path.dirname(filePath), linkTarget);

  const candidates = buildRewriteCandidates(absTarget, policy.pathRewrite);

  for (const candidate of candidates) {
    const result = await resolveReadablePath(candidate, policy, seen, depth + 1);
    if (result.kind === 'file' || result.kind === 'directory') {
      result.chain = [linkTarget, ...candidates.filter((c) => c !== absTarget), ...result.chain];
      return result;
    }
  }

  return {
    kind: 'missing',
    reason: 'symlink target unresolved',
    chain: [linkTarget, ...candidates.filter((c) => c !== absTarget)],
    external: true,
  };
}

export function formatSymlinkNote(
  symlinkTarget: string,
  readPath: string,
  sourcePath: string,
  boundaryRoots: readonly string[],
): string {
  const safeTarget = toSafePathLabel(symlinkTarget, [...boundaryRoots, path.dirname(sourcePath)]);
  let note = `\n# symlink target: ${safeTarget}`;
  if (toPosixPath(readPath) !== toPosixPath(sourcePath)) {
    const safeResolved = toSafePathLabel(readPath, boundaryRoots);
    if (safeResolved !== safeTarget) {
      note += `\n# resolved path: ${safeResolved}`;
    }
  }
  return note;
}

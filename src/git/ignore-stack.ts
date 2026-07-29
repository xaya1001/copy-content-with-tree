import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { toPosixPath } from '../core/paths';

export interface IgnoreLayer {
  /** Workspace-relative POSIX directory that owns this .gitignore ('' for workspace root). */
  baseRel: string;
  patterns: string[];
  ig: Ignore;
}

/**
 * Nested .gitignore stack for non-Git walks.
 * Later matching rules win across nested files (including `!` re-includes), matching Git.
 */
export class IgnoreStack {
  private readonly layers: IgnoreLayer[] = [];

  push(baseRel: string, patterns: readonly string[]): void {
    const list = [...patterns];
    const ig = ignore();
    if (list.length > 0) ig.add(list);
    this.layers.push({
      baseRel: toPosixPath(baseRel).replace(/^\/+|\/+$/g, ''),
      patterns: list,
      ig,
    });
  }

  pop(): void {
    this.layers.pop();
  }

  /**
   * Returns true when the path is ignored by the current stack.
   * `relPath` is workspace-relative POSIX without leading slash.
   */
  ignores(relPath: string, isDirectory = false): boolean {
    const clean = toPosixPath(relPath).replace(/^\/+|\/+$/g, '');
    if (!clean) return false;

    let ignored = false;
    for (const layer of this.layers) {
      const relative = relativeToBase(clean, layer.baseRel);
      if (relative === null || relative === '') continue;

      const probe = isDirectory ? `${relative.replace(/\/$/, '')}/` : relative;
      try {
        // Seed a current-ignored marker so a deeper `!` pattern can re-include,
        // matching Git's cross-file last-match-wins behavior.
        const ig = ignore();
        if (ignored) ig.add(['**/*']);
        if (layer.patterns.length > 0) ig.add(layer.patterns);
        ignored = ig.ignores(probe) || ig.ignores(relative);
      } catch {
        // ignore package may throw on invalid pathnames; keep prior decision.
      }
    }
    return ignored;
  }
}

function relativeToBase(displayPath: string, base: string): string | null {
  if (!base) return displayPath;
  if (displayPath === base) return '';
  if (!displayPath.startsWith(`${base}/`)) return null;
  return displayPath.slice(base.length + 1);
}

export async function readGitignorePatterns(dir: string, fileName: string): Promise<string[]> {
  const gitignorePath = path.join(dir, fileName);
  let content: string;
  try {
    content = await fs.readFile(gitignorePath, 'utf8');
  } catch {
    return [];
  }

  return content
    .split(/\r?\n/)
    .map((line) => line.replace(/^\uFEFF/, ''))
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed.length > 0 && !trimmed.startsWith('#');
    });
}

export async function pushGitignoreForDir(
  stack: IgnoreStack,
  workspaceFolder: string,
  absoluteDir: string,
  fileName: string,
): Promise<void> {
  const patterns = await readGitignorePatterns(absoluteDir, fileName);
  const relative = toPosixPath(path.relative(workspaceFolder, absoluteDir));
  const baseRel = !relative || relative === '.' ? '' : relative.replace(/^\/+|\/+$/g, '');
  stack.push(baseRel, patterns);
}

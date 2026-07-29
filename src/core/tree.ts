import { escapePathForDisplay } from './paths';

export interface TreeEntry {
  /** Raw relative path; may contain spaces, tabs, newlines, or `  # `. */
  path: string;
  /** Optional status / skip label kept separate from the path. */
  comment?: string;
}

interface TreeNode {
  children: Map<string, TreeNode>;
  /** Directory marker when this node was created as an intermediate path segment. */
  isDirectory: boolean;
  comment?: string;
}

/**
 * Build a compact tree. Path and comment are structured separately so a literal
 * `  # ` inside a filename is never treated as a status marker.
 */
export function makeTree(entries: readonly TreeEntry[]): string {
  const root: TreeNode = { children: new Map(), isDirectory: true };

  for (const entry of entries) {
    const parts = entry.path.split('/').filter((part) => part.length > 0);
    if (parts.length === 0) continue;

    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      const isLast = i === parts.length - 1;
      let child = node.children.get(part);
      if (!child) {
        child = { children: new Map(), isDirectory: !isLast };
        node.children.set(part, child);
      } else if (!isLast) {
        child.isDirectory = true;
      }
      node = child;
      if (isLast && entry.comment) {
        node.comment = entry.comment;
      }
    }
  }

  const lines: string[] = [];
  writeNode(root, '', lines);
  return lines.join('\n');
}

function writeNode(node: TreeNode, indent: string, lines: string[]): void {
  const keys = [...node.children.keys()].sort((a, b) => {
    const childA = node.children.get(a)!;
    const childB = node.children.get(b)!;
    if (childA.isDirectory !== childB.isDirectory) {
      return childA.isDirectory ? -1 : 1;
    }
    return escapePathForDisplay(a).localeCompare(escapePathForDisplay(b));
  });

  for (const key of keys) {
    const child = node.children.get(key)!;
    const displayName = escapePathForDisplay(key) + (child.isDirectory ? '/' : '');
    const comment = child.comment ? `  # ${escapePathForDisplay(child.comment)}` : '';
    lines.push(indent + displayName + comment);
    writeNode(child, `${indent}  `, lines);
  }
}

export function sortTreeEntries(entries: readonly TreeEntry[]): TreeEntry[] {
  return [...entries].sort((a, b) => a.path.localeCompare(b.path));
}

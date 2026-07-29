import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { mergeExcludes, readConfigFromGetter, type ExtensionConfig } from './core/config';
import { toDisplayPath, toSafePathLabel } from './core/paths';
import {
  buildCopyContent,
  buildCopyDiff,
  buildCopyTree,
  EmptyDiffError,
  formatReasons,
  NothingCopiedError,
  OutputLimitError,
} from './commands/build';
import { resolveReadablePath } from './fs/symlink';
import { formatGitUserError, isCancellationError } from './git/exec';
import { IgnoreStack, pushGitignoreForDir } from './git/ignore-stack';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'copyContentWithTree.copy',
      async (uri?: vscode.Uri, selectedUris?: vscode.Uri[]) => {
        await withProgress('Copy Content with Tree', async (signal) => {
          await runCopyContent(uri, selectedUris, signal);
        });
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'copyContentWithTree.copyTree',
      async (uri?: vscode.Uri, selectedUris?: vscode.Uri[]) => {
        await withProgress('Copy Tree', async (signal) => {
          await runCopyTree(uri, selectedUris, signal);
        });
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'copyContentWithTree.copyDiff',
      async (uri?: vscode.Uri, selectedUris?: vscode.Uri[]) => {
        await withProgress('Copy Git Diff with Tree', async (signal) => {
          await runCopyDiff(uri, selectedUris, signal);
        });
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'copyContentWithTree.debugSelection',
      async (uri?: vscode.Uri, selectedUris?: vscode.Uri[]) => {
        await runDebug(uri, selectedUris);
      },
    ),
  );
}

export function deactivate(): void {}

async function withProgress(
  title: string,
  task: (signal: AbortSignal) => Promise<void>,
): Promise<void> {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title,
      cancellable: true,
    },
    async (_progress, token) => {
      const controller = new AbortController();
      const subscription = token.onCancellationRequested(() => {
        controller.abort();
      });
      try {
        await task(controller.signal);
      } catch (err) {
        if (
          isCancellationError(err) ||
          controller.signal.aborted ||
          token.isCancellationRequested
        ) {
          return;
        }
        throw err;
      } finally {
        subscription.dispose();
      }
    },
  );
}

function getConfig(): ExtensionConfig {
  const config = vscode.workspace.getConfiguration('copyContentWithTree');
  return readConfigFromGetter((key, fallback) => config.get(key, fallback));
}

function getTargets(uri?: vscode.Uri, selectedUris?: vscode.Uri[]): vscode.Uri[] {
  if (Array.isArray(selectedUris) && selectedUris.length > 0) {
    return selectedUris.filter(Boolean);
  }
  if (uri) return [uri];
  const active = vscode.window.activeTextEditor?.document?.uri;
  return active ? [active] : [];
}

function getWorkspaceRoot(uri: vscode.Uri): string {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (folder) return folder.uri.fsPath;
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
}

/**
 * Reject multi-root selections so display paths cannot collide across folders.
 */
function resolveSingleWorkspaceFolder(targets: vscode.Uri[]): string {
  const roots = targets.map((target) => path.resolve(getWorkspaceRoot(target)));
  const unique = [...new Set(roots)];
  if (unique.length > 1) {
    throw new MultiRootSelectionError(
      'Selection spans multiple workspace folders. Select paths from a single folder and retry.',
    );
  }
  return unique[0] ?? path.resolve(process.cwd());
}

class MultiRootSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MultiRootSelectionError';
  }
}

async function runCopyTree(
  uri: vscode.Uri | undefined,
  selectedUris: vscode.Uri[] | undefined,
  signal: AbortSignal,
): Promise<void> {
  try {
    const targets = getTargets(uri, selectedUris);
    if (targets.length === 0) {
      vscode.window.showWarningMessage('Copy Tree: no file or folder selected.');
      return;
    }

    const workspaceFolder = resolveSingleWorkspaceFolder(targets);
    const result = await buildCopyTree({
      workspaceFolder,
      targets: targets.map((t) => ({ fsPath: t.fsPath })),
      config: getConfig(),
      allowGit: vscode.workspace.isTrusted,
      signal,
    });

    await vscode.env.clipboard.writeText(result.output);
    const skipped = result.skipped ? `, skipped ${result.skipped}` : '';
    vscode.window.showInformationMessage(
      `Copy Tree: copied ${result.pathCount} path(s)${skipped}.`,
    );
  } catch (err) {
    if (isCancellationError(err) || signal.aborted) return;
    if (err instanceof MultiRootSelectionError) {
      vscode.window.showWarningMessage(`Copy Tree: ${err.message}`);
      return;
    }
    if (err instanceof NothingCopiedError) {
      vscode.window.showWarningMessage(err.message);
      return;
    }
    if (err instanceof OutputLimitError) {
      vscode.window.showErrorMessage(err.message);
      return;
    }
    vscode.window.showErrorMessage(
      `Copy Tree failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function runCopyContent(
  uri: vscode.Uri | undefined,
  selectedUris: vscode.Uri[] | undefined,
  signal: AbortSignal,
): Promise<void> {
  try {
    const targets = getTargets(uri, selectedUris);
    if (targets.length === 0) {
      vscode.window.showWarningMessage('Copy Content with Tree: no file or folder selected.');
      return;
    }

    const workspaceFolder = resolveSingleWorkspaceFolder(targets);
    const result = await buildCopyContent({
      workspaceFolder,
      targets: targets.map((t) => ({ fsPath: t.fsPath })),
      config: getConfig(),
      allowGit: vscode.workspace.isTrusted,
      signal,
    });

    await vscode.env.clipboard.writeText(result.output);
    const reasonText = formatReasons(result.skippedReasons);
    const msg =
      `Copy Content with Tree: copied ${result.fileCount} file(s)` +
      (result.skipped ? `, skipped ${result.skipped}` : '') +
      (reasonText ? ` (${reasonText})` : '') +
      '.';
    vscode.window.showInformationMessage(msg);
  } catch (err) {
    if (isCancellationError(err) || signal.aborted) return;
    if (err instanceof MultiRootSelectionError) {
      vscode.window.showWarningMessage(`Copy Content with Tree: ${err.message}`);
      return;
    }
    if (err instanceof NothingCopiedError) {
      vscode.window.showWarningMessage(err.message);
      return;
    }
    if (err instanceof OutputLimitError) {
      vscode.window.showErrorMessage(err.message);
      return;
    }
    vscode.window.showErrorMessage(
      `Copy Content with Tree failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function runCopyDiff(
  uri: vscode.Uri | undefined,
  selectedUris: vscode.Uri[] | undefined,
  signal: AbortSignal,
): Promise<void> {
  try {
    if (!vscode.workspace.isTrusted) {
      vscode.window.showErrorMessage(
        'Copy Git Diff with Tree requires a trusted workspace. Trust this folder to run Git operations.',
      );
      return;
    }

    const targets = getTargets(uri, selectedUris);
    const workspaceFolder = targets[0]
      ? resolveSingleWorkspaceFolder(targets)
      : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    if (!workspaceFolder) {
      vscode.window.showWarningMessage('Copy Git Diff with Tree: no workspace is open.');
      return;
    }

    const result = await buildCopyDiff({
      workspaceFolder,
      targets:
        targets.length > 0
          ? targets.map((t) => ({ fsPath: t.fsPath }))
          : [{ fsPath: workspaceFolder }],
      config: getConfig(),
      allowGit: true,
      signal,
    });

    await vscode.env.clipboard.writeText(result.output);
    const filterText = result.filteredCount ? `, filtered ${result.filteredCount}` : '';
    vscode.window.showInformationMessage(
      `Copy Git Diff with Tree: copied diff for ${result.fileCount} file(s)${filterText}.`,
    );
  } catch (err) {
    if (isCancellationError(err) || signal.aborted) return;
    if (err instanceof MultiRootSelectionError) {
      vscode.window.showWarningMessage(`Copy Git Diff with Tree: ${err.message}`);
      return;
    }
    if (err instanceof EmptyDiffError) {
      vscode.window.showInformationMessage(`Copy Git Diff with Tree: ${err.message}.`);
      return;
    }
    if (err instanceof OutputLimitError) {
      vscode.window.showErrorMessage(err.message);
      return;
    }
    vscode.window.showErrorMessage(`Copy Git Diff with Tree failed: ${formatGitUserError(err)}`);
  }
}

async function runDebug(
  uri: vscode.Uri | undefined,
  selectedUris: vscode.Uri[] | undefined,
): Promise<void> {
  const targets = getTargets(uri, selectedUris);
  let workspaceFolder: string;
  try {
    workspaceFolder = targets.length > 0 ? resolveSingleWorkspaceFolder(targets) : process.cwd();
  } catch (err) {
    vscode.window.showWarningMessage(
      `Copy Content with Tree: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  const config = getConfig();
  const lines: string[] = [];

  lines.push('### Copy Content with Tree Debug');
  lines.push(`workspaceFolder: ${toSafePathLabel(workspaceFolder, [workspaceFolder])}`);
  lines.push(`targetCount: ${targets.length}`);
  lines.push(`useGitignore: ${config.useGitignore}`);
  lines.push(`gitignoreFileName: ${config.gitignoreFileName}`);
  lines.push(`exclude: ${JSON.stringify(config.exclude)}`);
  lines.push(`blacklist: ${JSON.stringify(config.blacklist)}`);
  lines.push(
    `effectiveExcludes: ${JSON.stringify(mergeExcludes(config.exclude, config.blacklist))}`,
  );
  lines.push(`pathRewrite rules: ${config.pathRewrite.length}`);
  lines.push(`allowExternalSymlinkTargets: ${config.allowExternalSymlinkTargets}`);
  lines.push(`workspaceTrusted: ${vscode.workspace.isTrusted}`);
  lines.push('');

  for (const target of targets) {
    const filePath = target.fsPath;
    const displayPath = toDisplayPath(workspaceFolder, filePath);
    lines.push(`## ${displayPath}`);

    try {
      const lst = await fs.lstat(filePath);
      lines.push(
        `lstat: ${lst.isFile() ? 'file' : ''}${lst.isDirectory() ? 'directory' : ''}${lst.isSymbolicLink() ? 'symlink' : ''}, size=${lst.size}`,
      );

      if (lst.isSymbolicLink()) {
        let linkTarget = '';
        try {
          linkTarget = await fs.readlink(filePath);
          lines.push(
            `readlink: ${toSafePathLabel(linkTarget, [workspaceFolder, path.dirname(filePath)])}`,
          );
        } catch (err) {
          lines.push(`readlink error: ${err instanceof Error ? err.message : String(err)}`);
        }

        const resolved = await resolveReadablePath(filePath, {
          followFileSymlinks: config.followFileSymlinks,
          allowExternalSymlinkTargets: config.allowExternalSymlinkTargets,
          pathRewrite: config.pathRewrite,
          boundaryRoots: [workspaceFolder, ...targets.map((t) => t.fsPath)],
        });
        lines.push(`resolved kind: ${resolved.kind}`);
        lines.push(`resolved external: ${resolved.external}`);
        if (resolved.readPath) {
          lines.push(`resolved readPath: ${toSafePathLabel(resolved.readPath, [workspaceFolder])}`);
        }
        if (resolved.reason) lines.push(`resolved reason: ${resolved.reason}`);
      }

      if (config.useGitignore) {
        const stack = new IgnoreStack();
        await pushGitignoreForDir(
          stack,
          workspaceFolder,
          workspaceFolder,
          config.gitignoreFileName,
        );
        lines.push(`gitignore ignored: ${stack.ignores(displayPath, lst.isDirectory())}`);
      }
    } catch (err) {
      lines.push(`lstat error: ${err instanceof Error ? err.message : String(err)}`);
    }

    lines.push('');
  }

  await vscode.env.clipboard.writeText(lines.join('\n'));
  vscode.window.showInformationMessage('Copy Content with Tree: debug info copied to clipboard.');
}

import assert from 'node:assert/strict';
import Module from 'node:module';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const NS = 'cwt';

type LoadFn = (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown;

test('extension smoke: activate registers four command ids and copyTree works', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `${NS}-smoke-`));
  const handlers = new Map<string, (...args: unknown[]) => Promise<void>>();
  let clipboard = '';

  try {
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'README.md'), 'NO_BODY');
    await fs.writeFile(path.join(root, 'src', 'app.js'), 'NO_BODY');

    const config: Record<string, unknown> = {
      exclude: [],
      blacklist: [],
      useGitignore: false,
      gitignoreFileName: '.gitignore',
      maxOutputChars: 20_000_000,
      maxFileSizeKB: 1024,
      includeSkippedInTree: false,
      followFileSymlinks: true,
      allowExternalSymlinkTargets: false,
      pathRewrite: [],
      diffAutoFetch: false,
      diffIncludeUntracked: true,
      diffUnifiedLines: 0,
      gitTimeoutMs: 60_000,
      gitMaxBufferBytes: 64 * 1024 * 1024,
    };

    const vscodeMock = {
      ProgressLocation: { Notification: 15 },
      commands: {
        registerCommand(name: string, handler: (...args: unknown[]) => Promise<void>) {
          handlers.set(name, handler);
          return { dispose() {} };
        },
      },
      env: {
        clipboard: {
          async writeText(value: string) {
            clipboard = value;
          },
        },
      },
      window: {
        activeTextEditor: undefined,
        showWarningMessage() {},
        showErrorMessage(message: string) {
          throw new Error(message);
        },
        showInformationMessage() {},
        async withProgress(
          _opts: unknown,
          task: (
            progress: unknown,
            token: {
              isCancellationRequested: boolean;
              onCancellationRequested: (cb: () => void) => { dispose(): void };
            },
          ) => Promise<void>,
        ) {
          await task(
            {},
            {
              isCancellationRequested: false,
              onCancellationRequested() {
                return { dispose() {} };
              },
            },
          );
        },
      },
      workspace: {
        isTrusted: true,
        workspaceFolders: [{ uri: { fsPath: root } }],
        getWorkspaceFolder() {
          return { uri: { fsPath: root } };
        },
        getConfiguration() {
          return {
            get(key: string, fallback: unknown) {
              return key in config ? config[key] : fallback;
            },
          };
        },
      },
    };

    const moduleAny = Module as unknown as { _load: LoadFn };
    const originalLoad = moduleAny._load;
    moduleAny._load = function (request, parent, isMain) {
      if (request === 'vscode') return vscodeMock;
      return originalLoad(request, parent, isMain);
    };

    try {
      const resolved = require.resolve('../dist/extension.js');
      delete require.cache[resolved];
      for (const key of Object.keys(require.cache)) {
        if (key.includes(`${path.sep}dist${path.sep}`)) delete require.cache[key];
      }
      const extension = require('../dist/extension.js') as {
        activate: (ctx: { subscriptions: unknown[] }) => void;
      };
      extension.activate({ subscriptions: [] });
    } finally {
      moduleAny._load = originalLoad;
    }

    assert.ok(handlers.has('copyContentWithTree.copy'));
    assert.ok(handlers.has('copyContentWithTree.copyTree'));
    assert.ok(handlers.has('copyContentWithTree.copyDiff'));
    assert.ok(handlers.has('copyContentWithTree.debugSelection'));

    await handlers.get('copyContentWithTree.copyTree')!({ fsPath: root }, [{ fsPath: root }]);
    assert.equal(clipboard, '### tree\nsrc/\n  app.js\nREADME.md');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

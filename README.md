# Copy Content with Tree

VS Code / VSCodium extension that copies a compact path tree and selected file contents to the clipboard—useful for AI chat context. It also supports **Copy Tree** (tree only) and **Copy Git Diff with Tree** (changed-file tree + patch against branch upstream).

**Publisher:** `xaya1001`

**License:** MIT (see `LICENSE`)

**Repository:** https://github.com/xaya1001/copy-content-with-tree

## Features

- **Copy Content with Tree** — path tree + UTF-8 file contents
- **Copy Tree** — filtered path tree only (no file bodies)
- **Copy Git Diff with Tree** — changed-file tree + diff against `merge-base(HEAD, @{u})`
- Nested `.gitignore` support (Git is authoritative inside trusted repositories)
- Untrusted workspaces: Copy Content/Tree use filesystem + ignore stack only (never start Git)
- Tracked-but-ignored files stay included; ignored untracked files stay out
- Rename-aware diffs that keep old/new paths together
- Unicode / spaces / tabs / special characters in paths via Git `-z` output
- Tree/header display escapes control characters; status comments are structured separately from filenames
- Symlink safety defaults (directory symlinks never traversed; external targets refused)
- Workspace Trust required for Git operations; Diff menu hidden when untrusted
- Progress notification with cancellation for long runs

## Install

### From a VSIX

1. Download the `.vsix` from [GitHub Releases](https://github.com/xaya1001/copy-content-with-tree/releases).
2. In VS Code: **Extensions → … → Install from VSIX…**

### Marketplace / Open VSX (planned)

Publishing to the Visual Studio Marketplace and Open VSX is intentionally not automated in CI yet. Maintainers must configure publisher credentials outside this repository (never commit tokens). When ready:

1. Create a publisher on the target registry (`xaya1001` or a later official publisher id).
2. Authenticate with the registry CLI (`vsce login` / `ovsx login`) using a secret stored in CI or a local secure store.
3. Publish the release VSIX built from a `vX.Y.Z` tag.

Until those credentials exist, use the GitHub Release VSIX.

## Privacy and security

- The extension only reads paths you select (plus Git metadata for Copy Diff in trusted workspaces).
- Clipboard output uses workspace-relative paths. Absolute host paths are not written into normal copy output.
- Control characters in paths are escaped in tree/header display; Git still receives the original paths.
- File symlink targets outside the workspace/selection boundary are refused unless you enable `copyContentWithTree.allowExternalSymlinkTargets`.
- Directory symlinks are never traversed.
- `pathRewrite` defaults to `[]`. Do not put private machine paths into shared settings.
- `diffAutoFetch` defaults to `false`.
- Copy Diff requires a **trusted** workspace because it runs `git`.
- Selections that span multiple workspace folders are rejected to avoid display-path collisions.

## Usage

1. Select files or folders in Explorer (file scheme).
2. Right-click → **Copy Content with Tree**, **Copy Tree**, or **Copy Git Diff with Tree** (Diff only when trusted).
3. Paste into your editor or AI chat.

Debug Selection is available from the Command Palette only.

### Diff behavior

- Base: `git merge-base HEAD @{u}`
- Includes committed branch changes and tracked working-tree changes
- Staged new files included; untracked files included by default as new-file patches
- Tree markers: `# modified`, `# deleted`, `# new`, `# renamed from old/path`
- Default unified context lines: `0` (set `diffUnifiedLines` to `3` for normal context)

## Settings

| Setting                       | Default    | Notes                                                                        |
| ----------------------------- | ---------- | ---------------------------------------------------------------------------- |
| `exclude`                     | built-ins  | Shared/project exclude patterns (plain names match full path segments only)  |
| `blacklist`                   | `[]`       | Extra exclude patterns merged with built-ins and `exclude`                   |
| `useGitignore`                | `true`     | Git-backed inside trusted repos; nested `.gitignore` outside Git / untrusted |
| `maxFileSizeKB`               | `1024`     | Skip large files when copying content                                        |
| `maxOutputChars`              | `20000000` | Clipboard size guard (`0` disables)                                          |
| `includeSkippedInTree`        | `false`    | Keep skipped entries in the tree with comments                               |
| `followFileSymlinks`          | `true`     | Follow file symlinks inside boundary; directory symlinks are never traversed |
| `allowExternalSymlinkTargets` | `false`    | Opt in to external symlink targets                                           |
| `pathRewrite`                 | `[]`       | Optional absolute path rewrite rules                                         |
| `diffAutoFetch`               | `false`    | Optional `git fetch --prune` before diff                                     |
| `diffIncludeUntracked`        | `true`     | Append untracked patches                                                     |
| `diffUnifiedLines`            | `0`        | Diff context lines                                                           |
| `gitTimeoutMs`                | `60000`    | Per-Git-process timeout                                                      |
| `gitMaxBufferBytes`           | `67108864` | Per-Git-process output cap                                                   |

## Development

Requires Node.js 22+.

```bash
npm ci
npm run check
```

`npm run check` runs format, lint, typecheck, unit/integration coverage, `npm audit`, VSIX packaging/content checks, and a real Extension Host smoke (`@vscode/test-cli` / `@vscode/test-electron`). On headless Linux it uses `xvfb-run` automatically.

CI runs the Node test matrix on Ubuntu, Windows, and macOS. VSIX packaging and Extension Host smoke run on Ubuntu.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for layout and workflow.

## Limitations

- Virtual workspaces are not supported.
- Copy Diff needs Git on `PATH`, a repository, and a configured upstream.
- Binary files are skipped for content copy.
- Directory symlinks are not traversed.
- Only the `file` scheme appears in Explorer context menus.
- Selecting a parent folder does not recursively discover nested Git repositories under it; select a path inside the nested repo instead.
- Bundle runtime target is Node 16 to stay compatible with VS Code `^1.80.0` engines.
- CI Extension Host smoke runs against both `1.80.0` (engines minimum) and `stable`; local `npm run check` uses `stable` only.

## License

MIT © Xiao Yao

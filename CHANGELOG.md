# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-07-29

First public release of **Copy Content with Tree**.

### Features

- **Copy Content with Tree** — compact path tree plus UTF-8 file contents for AI context.
- **Copy Tree** — filtered path tree only (no file bodies).
- **Copy Git Diff with Tree** — changed-file tree and patch against `merge-base(HEAD, @{u})`.
- Nested `.gitignore` handling: Git is authoritative in trusted repositories; a filesystem ignore stack applies outside Git and in untrusted workspaces.
- Workspace Trust gating: untrusted Copy Content/Tree never start Git; Copy Diff requires trust and is hidden when untrusted.
- Tracked-but-ignored files included via Git `ls-files`; ignored untracked files stay out.
- Rename-aware diffs that keep old and new paths in one tracked patch.
- NUL-separated (`-z`) Git path parsing that preserves Unicode, spaces, tabs, and newlines.
- Structured tree entries with status comments separate from filenames; control characters escaped in tree/header display.
- Symlink safety: directory symlinks are never traversed; external file symlink targets are refused unless opted in.
- Micromatch excludes with segment-exact matching for plain names; `exclude` and `blacklist` merge with built-ins.
- Literal Git pathspecs for selection and status paths; human metadata keeps raw path strings.
- Progress notification with cancellation; Git timeouts with SIGKILL fallback.
- Empty default `pathRewrite`; clipboard metadata stays workspace-relative.
- MIT license with CONTRIBUTING, SECURITY, and CODE_OF_CONDUCT.
- CI on Ubuntu/Windows/macOS for Node tests; Ubuntu VSIX packaging and Extension Host smoke on VS Code `1.80.0` and `stable`.
- Release workflow produces a VSIX with checksums and `actions/attest` provenance.

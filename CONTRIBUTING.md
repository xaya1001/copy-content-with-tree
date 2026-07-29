# Contributing

Thanks for contributing to **Copy Content with Tree**.

## Development setup

```bash
npm ci
npm run check
```

Useful scripts:

| Script                                                        | Purpose                                                     |
| ------------------------------------------------------------- | ----------------------------------------------------------- |
| `npm run build`                                               | Bundle `src/extension.ts` → `dist/extension.js` via esbuild |
| `npm run test`                                                | Build and run Node tests                                    |
| `npm run test:coverage`                                       | Coverage gate (core lines ≥ 80%)                            |
| `npm run lint` / `npm run typecheck` / `npm run format:check` | Static checks                                               |
| `npm run package`                                             | Build a `.vsix`                                             |
| `npm run check`                                               | Full local gate including VSIX content checks               |

## Workflow

1. Create a focused branch from `main`.
2. Keep changes scoped; prefer tests next to the behavior you change.
3. Do not commit `dist/`, coverage output, or `.vsix` artifacts.
4. Do not add secrets, tokens, or private host paths to defaults, docs, or fixtures.
5. Open a Ready-for-review PR. CI must pass before merge.

## Code layout

- `src/extension.ts` — thin VS Code adapter (commands, progress, trust, clipboard)
- `src/commands/` — pure builders used by commands and tests
- `src/core/` — config, paths, excludes, tree, binary, output limits
- `src/fs/` — filesystem walk and symlink policy
- `src/git/` — Git subprocess, discovery, ignore stack, diff

## Security / audit

`npm run audit` must report zero vulnerabilities. Transitive test-tooling packages are pinned via `package.json` `overrides` when upstream has not yet absorbed clean dependency versions. Do not weaken overrides without verifying `npm audit` stays clean.

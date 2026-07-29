export const BUILT_IN_EXCLUDES: readonly string[] = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  'node_modules',
  'playwright-report',
  'test-results',
  'coverage',
  '.nyc_output',
  '.pytest_cache',
  '.ruff_cache',
  '.mypy_cache',
  '.cache',
  '.turbo',
  '**/.git/**',
  '**/dist/**',
  '**/out/**',
  '**/build/**',
  '**/.next/**',
  '**/.venv/**',
  '**/__pycache__/**',
];

export interface PathRewriteRule {
  from: string;
  to: string;
}

export interface ExtensionConfig {
  exclude: string[];
  blacklist: string[];
  useGitignore: boolean;
  gitignoreFileName: string;
  maxFileSizeKB: number;
  maxOutputChars: number;
  includeSkippedInTree: boolean;
  diffAutoFetch: boolean;
  diffIncludeUntracked: boolean;
  diffUnifiedLines: number;
  followFileSymlinks: boolean;
  allowExternalSymlinkTargets: boolean;
  pathRewrite: PathRewriteRule[];
  gitTimeoutMs: number;
  gitMaxBufferBytes: number;
}

export const DEFAULT_CONFIG: ExtensionConfig = {
  exclude: [
    '**/node_modules/**',
    'package-lock.json',
    'npm-shrinkwrap.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'bun.lock',
    'bun.lockb',
    'playwright-report',
    'test-results',
    'coverage',
    '.nyc_output',
    '.pytest_cache',
    '.ruff_cache',
    '.mypy_cache',
    '.cache',
    '.turbo',
    '**/.git/**',
    '**/dist/**',
    '**/out/**',
    '**/build/**',
    '**/.next/**',
    '**/.venv/**',
    '**/__pycache__/**',
  ],
  blacklist: [],
  useGitignore: true,
  gitignoreFileName: '.gitignore',
  maxFileSizeKB: 1024,
  maxOutputChars: 20_000_000,
  includeSkippedInTree: false,
  diffAutoFetch: false,
  diffIncludeUntracked: true,
  diffUnifiedLines: 0,
  followFileSymlinks: true,
  allowExternalSymlinkTargets: false,
  pathRewrite: [],
  gitTimeoutMs: 60_000,
  gitMaxBufferBytes: 64 * 1024 * 1024,
};

export function normalizeNonNegativeInteger(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

export function normalizePositiveInteger(value: unknown, fallback: number, minimum = 1): number {
  const n = normalizeNonNegativeInteger(value, fallback);
  return n < minimum ? fallback : n;
}

export function normalizePathRewrite(rules: unknown): PathRewriteRule[] {
  if (!Array.isArray(rules)) return [];

  return rules
    .map((rule) => {
      if (!rule || typeof rule !== 'object') return null;
      const from = String((rule as PathRewriteRule).from ?? '').trim();
      const to = String((rule as PathRewriteRule).to ?? '').trim();
      if (!from || !to) return null;
      return { from, to };
    })
    .filter((rule): rule is PathRewriteRule => rule !== null);
}

export function mergeExcludes(
  configuredExcludes: readonly string[] | undefined,
  configuredBlacklist: readonly string[] | undefined,
): string[] {
  const merged = [...BUILT_IN_EXCLUDES];
  for (const source of [configuredExcludes, configuredBlacklist]) {
    for (const pattern of source ?? []) {
      if (!merged.includes(pattern)) merged.push(pattern);
    }
  }
  return merged;
}

export function readConfigFromGetter(get: <T>(key: string, defaultValue: T) => T): ExtensionConfig {
  return {
    exclude: get('exclude', DEFAULT_CONFIG.exclude),
    blacklist: get('blacklist', DEFAULT_CONFIG.blacklist),
    useGitignore: get('useGitignore', DEFAULT_CONFIG.useGitignore),
    gitignoreFileName:
      String(get('gitignoreFileName', DEFAULT_CONFIG.gitignoreFileName) || '.gitignore').trim() ||
      '.gitignore',
    maxFileSizeKB: normalizePositiveInteger(
      get('maxFileSizeKB', DEFAULT_CONFIG.maxFileSizeKB),
      DEFAULT_CONFIG.maxFileSizeKB,
      1,
    ),
    maxOutputChars: normalizeNonNegativeInteger(
      get('maxOutputChars', DEFAULT_CONFIG.maxOutputChars),
      DEFAULT_CONFIG.maxOutputChars,
    ),
    includeSkippedInTree: get('includeSkippedInTree', DEFAULT_CONFIG.includeSkippedInTree),
    diffAutoFetch: get('diffAutoFetch', DEFAULT_CONFIG.diffAutoFetch),
    diffIncludeUntracked: get('diffIncludeUntracked', DEFAULT_CONFIG.diffIncludeUntracked),
    diffUnifiedLines: normalizeNonNegativeInteger(
      get('diffUnifiedLines', DEFAULT_CONFIG.diffUnifiedLines),
      DEFAULT_CONFIG.diffUnifiedLines,
    ),
    followFileSymlinks: get('followFileSymlinks', DEFAULT_CONFIG.followFileSymlinks),
    allowExternalSymlinkTargets: get(
      'allowExternalSymlinkTargets',
      DEFAULT_CONFIG.allowExternalSymlinkTargets,
    ),
    pathRewrite: normalizePathRewrite(get('pathRewrite', DEFAULT_CONFIG.pathRewrite)),
    gitTimeoutMs: normalizePositiveInteger(
      get('gitTimeoutMs', DEFAULT_CONFIG.gitTimeoutMs),
      DEFAULT_CONFIG.gitTimeoutMs,
      1000,
    ),
    gitMaxBufferBytes: normalizePositiveInteger(
      get('gitMaxBufferBytes', DEFAULT_CONFIG.gitMaxBufferBytes),
      DEFAULT_CONFIG.gitMaxBufferBytes,
      1024,
    ),
  };
}

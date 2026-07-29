import { spawnSync } from 'node:child_process';
import process from 'node:process';

const useXvfb = process.platform === 'linux' && !process.env.DISPLAY;
const command = useXvfb ? 'xvfb-run' : 'vscode-test';
const args = useXvfb ? ['-a', 'vscode-test'] : [];

const result = spawnSync(command, args, {
  stdio: 'inherit',
  env: process.env,
  shell: false,
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);

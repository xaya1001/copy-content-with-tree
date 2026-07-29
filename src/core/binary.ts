export function isProbablyBinary(buffer: Buffer): boolean {
  const len = Math.min(buffer.length, 8192);
  if (len === 0) return false;

  let suspicious = 0;
  for (let i = 0; i < len; i++) {
    const c = buffer[i]!;
    if (c === 0) return true;
    if (c === 9 || c === 10 || c === 13) continue;
    if (c < 32) suspicious++;
  }

  return suspicious / len > 0.05;
}

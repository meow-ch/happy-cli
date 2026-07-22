import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PROCESS_BIRTH_COMMAND_TIMEOUT_MS = 3_000;
let cachedLinuxBootId: string | null = null;
let cachedUnixBootIdentity: string | null = null;

function fingerprint(parts: string[]): string {
  const digest = createHash('sha256')
    .update(parts.join('\0'))
    .digest('hex');
  return `v1:${digest}`;
}

function readUtf8File(path: string): string | null {
  try {
    const value = readFileSync(path, 'utf8').trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function execUtf8(command: string, args: string[]): string | null {
  try {
    const value = execFileSync(command, args, {
      encoding: 'utf8',
      timeout: PROCESS_BIRTH_COMMAND_TIMEOUT_MS,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: {
        ...process.env,
        LC_ALL: 'C',
        LANG: 'C',
      },
    }).trim();
    return value.length > 0 ? value.replace(/\s+/g, ' ') : null;
  } catch {
    return null;
  }
}

function linuxStartTicks(stat: string): string | null {
  // `/proc/<pid>/stat` field 2 is a parenthesized command which may contain
  // spaces or parentheses. Everything after its final `)` begins at field 3;
  // process start time is field 22, hence zero-based offset 19 below.
  const commandEnd = stat.lastIndexOf(')');
  if (commandEnd < 0) return null;
  const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
  const value = fields[19];
  return value && /^\d+$/.test(value) ? value : null;
}

/**
 * Returns an opaque identity tied to one OS process incarnation.
 *
 * PID alone is not an identity because the kernel reuses it. Linux combines
 * boot id with `/proc` start ticks; Unix uses absolute process start time and
 * boot identity where available; Windows uses the process creation timestamp.
 * A null result is deliberately not substitutable with PID and must fail
 * closed wherever persisted daemon state is being trusted.
 */
export function readProcessBirthFingerprint(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;

  if (platform === 'linux') {
    const bootId = cachedLinuxBootId
      ?? readUtf8File('/proc/sys/kernel/random/boot_id');
    if (bootId) cachedLinuxBootId = bootId;
    const stat = readUtf8File(`/proc/${pid}/stat`);
    const startTicks = stat ? linuxStartTicks(stat) : null;
    if (!bootId || !startTicks) return null;
    return fingerprint(['linux', bootId, String(pid), startTicks]);
  }

  if (platform === 'win32') {
    const creationTicks = execUtf8('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
    ]);
    return creationTicks
      ? fingerprint(['win32', String(pid), creationTicks])
      : null;
  }

  const startedAt = execUtf8('ps', ['-o', 'lstart=', '-p', String(pid)]);
  if (!startedAt) return null;
  const observedBootIdentity = cachedUnixBootIdentity
    ?? execUtf8('sysctl', ['-n', 'kern.boottime']);
  if (observedBootIdentity) cachedUnixBootIdentity = observedBootIdentity;
  const bootIdentity = observedBootIdentity ?? 'boot-identity-unavailable';
  return fingerprint([platform, bootIdentity, String(pid), startedAt]);
}

export function processBirthFingerprintMatches(
  expected: string | undefined,
  observed: string | null,
): boolean {
  return typeof expected === 'string'
    && expected.length > 0
    && observed !== null
    && expected === observed;
}

export const __testProcessBirthFingerprint = {
  linuxStartTicks,
};

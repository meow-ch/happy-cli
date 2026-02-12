/**
 * Claude Code version check utilities
 *
 * Checks if the installed Claude Code CLI is outdated by comparing
 * against the latest version on npm. Uses a file-based cache with 24h TTL
 * to avoid repeated network requests.
 */

import fs from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import https from 'https';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';

// Use the CJS module for finding Claude CLI path and version
const { findGlobalClaudeCliPath, getVersion, compareVersions } = require('../../scripts/claude_version_utils.cjs');

const CACHE_FILE_NAME = 'claude-version-cache.json';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const FETCH_TIMEOUT_MS = 5000;

interface VersionCache {
  latestVersion: string;
  checkedAt: number;
}

interface ClaudeVersionCheckResult {
  installedVersion: string;
  latestVersion: string;
  installSource: string;
  isOutdated: boolean;
  updateCommand: string;
}

/**
 * Get the path to the version cache file
 */
function getCacheFilePath(): string {
  return path.join(configuration.happyHomeDir, CACHE_FILE_NAME);
}

/**
 * Fetch the latest Claude Code version from npm registry
 */
function fetchLatestClaudeVersion(): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get('https://registry.npmjs.org/@anthropic-ai/claude-code/latest', {
      timeout: FETCH_TIMEOUT_MS,
      headers: { 'Accept': 'application/json' }
    }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        res.resume();
        return;
      }

      let data = '';
      res.on('data', (chunk: string) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (typeof parsed.version !== 'string') {
            reject(new Error('No version field in response'));
            return;
          }
          resolve(parsed.version);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
  });
}

/**
 * Read the version cache (sync, for use in launcher)
 */
export function readVersionCacheSync(): VersionCache | null {
  const cacheFile = getCacheFilePath();
  try {
    if (!existsSync(cacheFile)) return null;
    const data = JSON.parse(readFileSync(cacheFile, 'utf8'));
    if (typeof data.latestVersion === 'string' && typeof data.checkedAt === 'number') {
      return data as VersionCache;
    }
  } catch (e) {
    // Corrupted or unreadable cache
  }
  return null;
}

/**
 * Read the version cache (async)
 */
async function readVersionCache(): Promise<VersionCache | null> {
  const cacheFile = getCacheFilePath();
  try {
    const data = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
    if (typeof data.latestVersion === 'string' && typeof data.checkedAt === 'number') {
      return data as VersionCache;
    }
  } catch (e) {
    // No cache or corrupted
  }
  return null;
}

/**
 * Write the version cache
 */
async function writeVersionCache(cache: VersionCache): Promise<void> {
  const cacheFile = getCacheFilePath();
  try {
    await fs.writeFile(cacheFile, JSON.stringify(cache), 'utf8');
  } catch (e) {
    logger.debug('[VERSION CHECK] Failed to write cache:', e);
  }
}

/**
 * Get the update command for a given installation source
 */
export function getUpdateCommand(source: string): string {
  switch (source) {
    case 'npm':
      return 'npm update -g @anthropic-ai/claude-code';
    case 'Bun':
      return 'bun update -g @anthropic-ai/claude-code';
    case 'Homebrew':
      return 'brew upgrade claude-code';
    case 'native installer':
      return 'claude update';
    default:
      return 'npm update -g @anthropic-ai/claude-code';
  }
}

/**
 * Get the currently installed Claude Code version (sync)
 */
export function getGlobalClaudeVersion(): string | null {
  const result = findGlobalClaudeCliPath();
  if (!result) return null;
  return getVersion(result.path) ?? null;
}

/**
 * Main version check function.
 * Gets installed version, checks cache (fetches if expired), compares versions.
 */
export async function checkClaudeVersion(): Promise<ClaudeVersionCheckResult | null> {
  const result = findGlobalClaudeCliPath();
  if (!result) return null;

  const installedVersion = getVersion(result.path);
  if (!installedVersion) return null;

  // Check cache
  let latestVersion: string | null = null;
  const cache = await readVersionCache();

  if (cache && (Date.now() - cache.checkedAt) < CACHE_TTL_MS) {
    latestVersion = cache.latestVersion;
  } else {
    // Fetch from npm
    try {
      latestVersion = await fetchLatestClaudeVersion();
      await writeVersionCache({
        latestVersion,
        checkedAt: Date.now()
      });
    } catch (e) {
      logger.debug('[VERSION CHECK] Failed to fetch latest version:', e);
      // Fall back to cached version if available
      if (cache) {
        latestVersion = cache.latestVersion;
      }
    }
  }

  if (!latestVersion) return null;

  const isOutdated = compareVersions(installedVersion, latestVersion) < 0;
  const updateCommand = getUpdateCommand(result.source);

  return {
    installedVersion,
    latestVersion,
    installSource: result.source,
    isOutdated,
    updateCommand
  };
}

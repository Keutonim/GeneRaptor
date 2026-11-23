/**
 * S5 T3 (round 2) — the data dir privacy warning (CWE-276 / CWE-732).
 *
 * The data dir holds the SQLite DB AND the per-install provider key file. The
 * operator may point --data-dir at a shared location (/tmp, C:\tmp, a synced
 * folder). The modes are tightened best effort, but when the location is still
 * not private the operator must be TOLD — without ever printing key material.
 *
 * Rules (results/s5-security-pre.md §4.3 п.5):
 *   - POSIX: the directory mode grants group/other access (mode & 0o077);
 *   - Windows: POSIX bits are not the boundary (NTFS ACLs are), so the rule is
 *     "the path lies outside the user profile".
 */
import { describe, it, expect, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import {
  dataDirPrivacyWarning,
  hardenDataPermissions,
} from '../../server/lib/data-dir.mjs';

const isPosix = process.platform !== 'win32';
const dirsToClean = [];

function tmpRoot(prefix = 'generaptor-privacy-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirsToClean.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirsToClean.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

describe('dataDirPrivacyWarning — Windows rule (path vs the user profile)', () => {
  it('warns when the data dir lies OUTSIDE the user profile', () => {
    const dir = tmpRoot();
    const outsideHome = resolve(sep, 'some-other-profile');
    const warning = dataDirPrivacyWarning({ dataDir: dir, home: outsideHome, platform: 'win32' });
    expect(typeof warning).toBe('string');
    expect(warning).toContain(dir);
    expect(warning).toMatch(/outside the user profile/i);
    expect(warning).toMatch(/^\[Data\] WARNING:/);
  });

  it('stays silent when the data dir is inside the user profile', () => {
    const home = tmpRoot('generaptor-privacy-home-');
    const dir = join(home, '.generaptor');
    expect(dataDirPrivacyWarning({ dataDir: dir, home, platform: 'win32' })).toBeNull();
    // The profile itself is private too.
    expect(dataDirPrivacyWarning({ dataDir: home, home, platform: 'win32' })).toBeNull();
  });

  it('the comparison is case-insensitive and separator-aware (Windows paths)', () => {
    const home = tmpRoot('generaptor-privacy-home-');
    const dir = join(home, 'instance');
    expect(
      dataDirPrivacyWarning({ dataDir: dir.toUpperCase(), home: home.toLowerCase(), platform: 'win32' }),
    ).toBeNull();
    // A sibling whose name merely STARTS with the profile name is not inside it.
    expect(
      dataDirPrivacyWarning({ dataDir: `${home}-evil`, home, platform: 'win32' }),
    ).toMatch(/outside the user profile/i);
  });

  it('never prints key material — only the path', () => {
    const dir = tmpRoot();
    const warning = dataDirPrivacyWarning({
      dataDir: dir,
      home: resolve(sep, 'another-profile'),
      platform: 'win32',
    });
    expect(warning).not.toMatch(/[A-Za-z0-9_-]{32,}/);
    expect(warning.split('\n')).toHaveLength(1);
  });

  it('no data dir → no warning', () => {
    expect(dataDirPrivacyWarning({})).toBeNull();
    expect(dataDirPrivacyWarning({ dataDir: '' })).toBeNull();
  });
});

describe('dataDirPrivacyWarning — POSIX rule (group/other bits)', () => {
  it('warns for a group/other-readable dir and stays silent for 0700', () => {
    const dir = tmpRoot();
    // Platform-independent part: the dir really exists and is inspectable.
    expect(statSync(dir).isDirectory()).toBe(true);
    if (!isPosix) return; // POSIX bits are not the boundary on Windows (NTFS ACLs).

    chmodSync(dir, 0o755);
    const loose = dataDirPrivacyWarning({ dataDir: dir, platform: 'linux' });
    expect(loose).toMatch(/readable by other users/i);
    expect(loose).toContain(dir);

    chmodSync(dir, 0o700);
    expect(dataDirPrivacyWarning({ dataDir: dir, platform: 'linux' })).toBeNull();

    chmodSync(dir, 0o770);
    expect(dataDirPrivacyWarning({ dataDir: dir, platform: 'linux' })).toMatch(
      /readable by other users/i,
    );
  });
});

describe('hardenDataPermissions — the warning is emitted at the permissions decision point', () => {
  it('logs the warning through the injected sink and keeps the boolean contract', () => {
    const dir = tmpRoot();
    const dbFile = join(dir, 'generaptor.db');
    writeFileSync(dbFile, 'sqlite-placeholder');
    const lines = [];

    const touched = hardenDataPermissions({
      dataDir: dir,
      databaseUrl: `file:${dbFile.split(sep).join('/')}`,
      home: resolve(sep, 'another-profile'),
      platform: 'win32',
      log: (message) => lines.push(message),
    });

    expect(touched).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(dir);
    expect(lines[0]).toMatch(/outside the user profile/i);
  });

  it('stays silent for a private location', () => {
    const home = tmpRoot('generaptor-privacy-home-');
    const dir = join(home, 'instance');
    const lines = [];
    hardenDataPermissions({
      dataDir: dir,
      home,
      platform: 'win32',
      log: (message) => lines.push(message),
    });
    expect(lines).toHaveLength(0);
  });

  it('the default sink is console.warn (the operator sees it on stderr)', () => {
    const dir = tmpRoot();
    const original = console.warn;
    const lines = [];
    console.warn = (message) => lines.push(message);
    try {
      hardenDataPermissions({
        dataDir: dir,
        home: resolve(sep, 'another-profile'),
        platform: 'win32',
      });
    } finally {
      console.warn = original;
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[Data\] WARNING:/);
  });
});

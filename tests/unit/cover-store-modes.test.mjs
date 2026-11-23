/**
 * S5 T3 (round 2) — D5: the cover store creates PRIVATE files.
 *
 * results/s5-security-verify.md §3.4: `covers/` was created without a mode
 * (0755) and cover binaries were written without one (0644). Inside a 0700
 * parent that is still unreadable to others, but the operator may point
 * --data-dir at a shared location — then the parent is not private and the
 * cover bytes (and the neighbourhood of the key file) are exposed.
 *
 * The store now creates the directory 0700 and writes the binary 0600. The
 * mode CONSTANTS are pinned here (they are the values production passes to
 * fs), and the resulting modes are asserted on POSIX. On Windows the POSIX
 * bits are not the security boundary (NTFS ACLs are) — the same convention as
 * tests/integration/provider-secret-at-rest.test.mjs.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  COVER_FILE_MODE,
  COVERS_DIR_MODE,
  resolveCoversDir,
  saveCoverBinary,
} from '../../server/lib/cover-store.mjs';

const ARTICLE_ID = '55555555-5555-4555-8555-555555555555';
const isPosix = process.platform !== 'win32';
const dirsToClean = [];

afterEach(() => {
  for (const dir of dirsToClean.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tmpDataDir() {
  const dir = mkdtempSync(join(tmpdir(), 'gr-cover-modes-'));
  dirsToClean.push(dir);
  return dir;
}

describe('cover store: private creation modes (S5 T3, D5)', () => {
  it('the store creates covers/ with 0700 and writes binaries with 0600', () => {
    expect(COVERS_DIR_MODE).toBe(0o700);
    expect(COVER_FILE_MODE).toBe(0o600);
  });

  it('the created directory and file really carry those modes (POSIX)', () => {
    const dataDir = tmpDataDir();
    const dir = resolveCoversDir({ dataDir });
    const cover = saveCoverBinary({
      articleId: ARTICLE_ID,
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      dataDir,
    });

    // Platform-independent: both paths exist and stay inside the data dir.
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(cover.path)).toBe(true);
    expect(dir).toBe(join(dataDir, 'covers'));
    expect(cover.path.startsWith(dir)).toBe(true);

    if (!isPosix) return; // NTFS ACLs are the boundary on Windows.
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(cover.path).mode & 0o777).toBe(0o600);
  });

  it('a second cover of the same article is private too', () => {
    const dataDir = tmpDataDir();
    const first = saveCoverBinary({ articleId: ARTICLE_ID, buffer: Buffer.from([1]), dataDir });
    const second = saveCoverBinary({ articleId: ARTICLE_ID, buffer: Buffer.from([2]), dataDir });
    expect(second.filename).not.toBe(first.filename);
    if (!isPosix) return;
    expect(statSync(first.path).mode & 0o777).toBe(0o600);
    expect(statSync(second.path).mode & 0o777).toBe(0o600);
  });
});

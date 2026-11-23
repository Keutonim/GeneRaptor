/**
 * Local cover store (docs/ui-design.md §12).
 *
 * Contract under test:
 *   - cover binaries live as FILES under <data-dir>/covers/;
 *   - the file name is <articleId>-<n>.<ext>;
 *   - the DB stores the file name, the binary route serves the bytes;
 *   - the content type follows the extension;
 *   - an absent cover reads as null (the route turns it into 404);
 *   - a file name that escapes the covers dir is refused;
 *   - deleting an article removes its cover files (delete cascade).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  COVERS_DIR_NAME,
  coverContentType,
  coverRouteFor,
  isSafeCoverFilename,
  readCoverBinary,
  removeArticleCovers,
  resolveCoversDir,
  saveCoverBinary,
} from '../../server/lib/cover-store.mjs';

const ARTICLE_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_ID = '44444444-4444-4444-8444-444444444444';

let dataDir;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'gr-cover-store-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('cover store: layout', () => {
  it('resolves <data-dir>/covers and creates it on demand', () => {
    const dir = resolveCoversDir({ dataDir });
    expect(dir).toBe(join(dataDir, COVERS_DIR_NAME));
    expect(existsSync(dir)).toBe(true);
  });

  it('maps the extension to the served content type', () => {
    expect(coverContentType('png')).toBe('image/png');
    expect(coverContentType('jpeg')).toBe('image/jpeg');
    expect(coverContentType('jpg')).toBe('image/jpeg');
    expect(coverContentType('webp')).toBe('image/webp');
    expect(coverContentType('exe')).toBe('application/octet-stream');
  });

  it('builds the binary route of an article', () => {
    expect(coverRouteFor(ARTICLE_ID)).toBe(`/api/articles/${ARTICLE_ID}/cover`);
  });
});

describe('cover store: write', () => {
  it('writes the binary under <data-dir>/covers/<articleId>-<n>.<ext>', () => {
    const saved = saveCoverBinary({
      articleId: ARTICLE_ID,
      buffer: Buffer.from('PNG-BYTES'),
      ext: 'png',
      dataDir,
    });

    expect(saved.filename).toBe(`${ARTICLE_ID}-1.png`);
    expect(saved.path).toBe(join(dataDir, COVERS_DIR_NAME, `${ARTICLE_ID}-1.png`));
    expect(existsSync(saved.path)).toBe(true);
    expect(readFileSync(saved.path).toString()).toBe('PNG-BYTES');
    expect(saved.contentType).toBe('image/png');
    expect(saved.bytes).toBe(9);
    expect(saved.route).toBe(`/api/articles/${ARTICLE_ID}/cover`);
  });

  it('increments the counter for a second cover of the same article', () => {
    const first = saveCoverBinary({
      articleId: ARTICLE_ID,
      buffer: Buffer.from('one'),
      ext: 'png',
      dataDir,
    });
    const second = saveCoverBinary({
      articleId: ARTICLE_ID,
      buffer: Buffer.from('two'),
      ext: 'png',
      dataDir,
    });

    expect(first.filename).toBe(`${ARTICLE_ID}-1.png`);
    expect(second.filename).toBe(`${ARTICLE_ID}-2.png`);
    expect(existsSync(first.path)).toBe(true);
    expect(existsSync(second.path)).toBe(true);
  });

  it('keeps the covers of different articles apart', () => {
    const mine = saveCoverBinary({
      articleId: ARTICLE_ID,
      buffer: Buffer.from('mine'),
      ext: 'png',
      dataDir,
    });
    const other = saveCoverBinary({
      articleId: OTHER_ID,
      buffer: Buffer.from('other'),
      ext: 'png',
      dataDir,
    });

    expect(mine.filename).not.toBe(other.filename);
    expect(other.filename).toBe(`${OTHER_ID}-1.png`);
  });
});

describe('cover store: read', () => {
  it('reads the bytes back with the content type', () => {
    const saved = saveCoverBinary({
      articleId: ARTICLE_ID,
      buffer: Buffer.from('PNG-BYTES'),
      ext: 'png',
      dataDir,
    });

    const read = readCoverBinary({
      articleId: ARTICLE_ID,
      file: saved.filename,
      dataDir,
    });

    expect(read).not.toBeNull();
    expect(read.buffer.toString()).toBe('PNG-BYTES');
    expect(read.contentType).toBe('image/png');
    expect(read.filename).toBe(saved.filename);
  });

  it('returns null when the cover file is absent (the route answers 404)', () => {
    expect(
      readCoverBinary({ articleId: ARTICLE_ID, file: `${ARTICLE_ID}-1.png`, dataDir }),
    ).toBeNull();
  });

  it('refuses a file name that escapes the covers dir', () => {
    expect(isSafeCoverFilename('../../secret.txt')).toBe(false);
    expect(isSafeCoverFilename('cover.png')).toBe(false);
    expect(isSafeCoverFilename(`${ARTICLE_ID}-1.png`)).toBe(true);

    writeFileSync(join(dataDir, 'secret.txt'), 'top-secret');
    expect(
      readCoverBinary({ articleId: ARTICLE_ID, file: '../secret.txt', dataDir }),
    ).toBeNull();
  });
});

describe('cover store: delete cascade', () => {
  it('removes every cover file of the article and keeps the others', () => {
    const mine = saveCoverBinary({
      articleId: ARTICLE_ID,
      buffer: Buffer.from('mine'),
      ext: 'png',
      dataDir,
    });
    const mineAgain = saveCoverBinary({
      articleId: ARTICLE_ID,
      buffer: Buffer.from('mine-again'),
      ext: 'jpeg',
      dataDir,
    });
    const other = saveCoverBinary({
      articleId: OTHER_ID,
      buffer: Buffer.from('other'),
      ext: 'png',
      dataDir,
    });

    const removed = removeArticleCovers(ARTICLE_ID, { dataDir });

    expect(removed).toBe(2);
    expect(existsSync(mine.path)).toBe(false);
    expect(existsSync(mineAgain.path)).toBe(false);
    expect(existsSync(other.path)).toBe(true);
  });

  it('is a no-op when the article has no covers', () => {
    expect(removeArticleCovers(ARTICLE_ID, { dataDir })).toBe(0);
  });
});

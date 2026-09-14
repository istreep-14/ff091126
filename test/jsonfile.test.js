import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeJsonAtomic } from '../src/jsonfile.js';

/**
 * The state files here are read with a try/catch that falls back to an empty
 * default, so a truncated write does not surface as an error — it surfaces as
 * "you have no league overrides", and the next write makes that permanent.
 */

const tmp = () => mkdtempSync(join(tmpdir(), 'ffjson-'));

test('writes and reads back', () => {
  const d = tmp();
  try {
    const p = join(d, 'a.json');
    writeJsonAtomic(p, { a: 1, b: [2, 3] });
    assert.deepEqual(JSON.parse(readFileSync(p, 'utf8')), { a: 1, b: [2, 3] });
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('creates missing parent directories', () => {
  const d = tmp();
  try {
    const p = join(d, 'deep', 'deeper', 'a.json');
    writeJsonAtomic(p, { ok: true });
    assert.deepEqual(JSON.parse(readFileSync(p, 'utf8')), { ok: true });
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('leaves no temporary file behind on success', () => {
  const d = tmp();
  try {
    writeJsonAtomic(join(d, 'a.json'), { a: 1 });
    assert.deepEqual(readdirSync(d), ['a.json']);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('a failed write leaves the previous file intact and no debris', () => {
  const d = tmp();
  try {
    const p = join(d, 'a.json');
    writeJsonAtomic(p, { good: true });
    // A circular structure throws inside JSON.stringify, after the temp path
    // has been chosen but before anything valid is written.
    const circular = {};
    circular.self = circular;
    assert.throws(() => writeJsonAtomic(p, circular));
    assert.deepEqual(JSON.parse(readFileSync(p, 'utf8')), { good: true });
    assert.deepEqual(readdirSync(d), ['a.json'], 'no .tmp left over');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('a reader never sees a partial file', () => {
  const d = tmp();
  try {
    const p = join(d, 'a.json');
    writeFileSync(p, JSON.stringify({ version: 0 }));
    // The point of the rename: at no instant does the path hold anything but
    // one complete document.
    for (let i = 1; i <= 20; i++) {
      writeJsonAtomic(p, { version: i, pad: 'x'.repeat(i * 500) });
      const got = JSON.parse(readFileSync(p, 'utf8'));
      assert.equal(got.version, i);
    }
  } finally { rmSync(d, { recursive: true, force: true }); }
});

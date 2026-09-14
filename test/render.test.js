import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderHtml } from '../src/dashboard.js';

/**
 * The payload goes into the page through one string replacement, and that
 * replacement was one character away from destroying the whole dashboard.
 *
 * None of these failures are visible anywhere but a browser, which is exactly
 * why they get a test.
 */

const shell = '<html><script id="payload" type="application/json">/*__DATA__*/null</script></html>';
/**
 * Read the payload back the way the page does.
 *
 * No unescaping step: `\u003c` is a JSON string escape, so JSON.parse resolves
 * it itself. That is exactly why escaping `<` is safe.
 */
const extract = (html) =>
  JSON.parse(html.match(/type="application\/json">([\s\S]*?)<\/script>/)[1]);

test('a dollar sign in the payload survives the injection', () => {
  // `$&`, `$'` and `$$` are substitution patterns to String.replace with a
  // string argument. A team nicknamed "Money$$" was enough to rewrite the
  // JSON as it was injected and blank the page on JSON.parse, with nothing to
  // point at.
  const payload = { teams: ['Money$$', "Dollar$' Store", 'All $& Any', '$1 $2 $`'] };
  const got = extract(renderHtml(shell, payload));
  assert.deepEqual(got, payload);
});

test('a closing script tag in the payload cannot end the block early', () => {
  const payload = { note: 'see </script><script>alert(1)</script>' };
  const html = renderHtml(shell, payload);
  // Exactly the two script tags the shell started with.
  assert.equal(html.match(/<\/script>/g).length, 1);
  assert.ok(!html.includes('<script>alert'), 'no injected tag survives');
  assert.deepEqual(extract(html), payload);
});

test('U+2028 and U+2029 are escaped', () => {
  // Legal inside a JSON string, but literal line terminators in JS source: a
  // player note carrying one produced an unterminated string at parse time.
  const payload = { note: 'line\u2028break\u2029here' };
  const html = renderHtml(shell, payload);
  assert.ok(!html.includes('\u2028'));
  assert.ok(!html.includes('\u2029'));
  assert.deepEqual(extract(html), payload);
});

test('the placeholder is replaced exactly once', () => {
  const html = renderHtml(shell, { a: 1 });
  assert.ok(!html.includes('/*__DATA__*/'));
});

test('a payload that happens to contain the placeholder is not re-expanded', () => {
  const payload = { note: '/*__DATA__*/null' };
  const got = extract(renderHtml(shell, payload));
  assert.deepEqual(got, payload);
});

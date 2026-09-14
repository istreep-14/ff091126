import { config } from './config.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A 304 from a conditional GET. Not an error — the caller's copy is current. */
export class NotModified extends Error {
  constructor(url) {
    super(`304 Not Modified: ${url}`);
    this.name = 'NotModified';
    this.notModified = true;
  }
}

/**
 * Fetch with retry + exponential backoff. Retries on 429/5xx and network errors.
 *
 * `withHeaders` returns `{ body, headers, status }` instead of the parsed body.
 * Response headers are otherwise unreachable, and without them there is no way
 * to see an ETag or Last-Modified — which is the difference between re-pulling
 * Sleeper's 15MB player dump and asking whether it changed.
 *
 * `etag` / `since` send If-None-Match / If-Modified-Since. A 304 throws
 * NotModified rather than returning null, because "unchanged" and "empty" are
 * different answers and every caller must distinguish them.
 */
export async function get(url, { retries = 3, asText = false, headers = {}, withHeaders = false, etag = null, since = null, method = 'GET', body = null, timeoutMs = config.timeoutMs } = {}) {
  const reqHeaders = { 'User-Agent': UA, Accept: '*/*', ...headers };
  if (etag) reqHeaders['If-None-Match'] = etag;
  if (since) reqHeaders['If-Modified-Since'] = since;

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // Without a deadline a stalled socket hangs the step, and with eleven
      // network steps behind one `sync` that is the whole pipeline. A timeout
      // aborts as a retryable error, which is what a stall is.
      const res = await fetch(url, {
        method,
        headers: reqHeaders,
        ...(timeoutMs > 0 ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
        ...(body != null ? { body } : {}),
      });
      if (res.status === 304) throw new NotModified(url);
      if (res.status === 429 || res.status >= 500) {
        throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status, retryable: true });
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw Object.assign(new Error(`HTTP ${res.status} for ${url}${body ? ` — ${body.slice(0, 160)}` : ''}`), { status: res.status, body });
      }
      const raw = await res.text();
      const meta = withHeaders ? { headers: headerMap(res.headers), status: res.status } : null;
      if (asText) return withHeaders ? { body: raw, ...meta } : raw;
      if (!raw.trim()) return withHeaders ? { body: null, ...meta } : null; // some endpoints return an empty body
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error(`Non-JSON response from ${url}: ${raw.slice(0, 120)}`);
      }
      return withHeaders ? { body: parsed, ...meta } : parsed;
    } catch (err) {
      if (err.notModified) throw err; // never retried; it is the answer
      lastErr = err.name === 'TimeoutError'
        ? Object.assign(new Error(`Timed out after ${timeoutMs}ms: ${url}`), { name: 'TimeoutError' })
        : err;
      const retryable = err.retryable || err.name === 'TypeError' || err.name === 'TimeoutError';
      if (!retryable || attempt === retries) break;
      await sleep(2 ** attempt * 500 + Math.random() * 250);
    }
  }
  throw lastErr;
}

/**
 * POST through the same retry, backoff and 429 handling as everything else.
 *
 * FanDuel's GraphQL endpoint was calling `fetch` directly and so was the one
 * source in the stack with no retry and no rate limiting — a transient 503
 * failed the whole sync where the other six would have backed off and
 * succeeded.
 */
export const post = (url, json, opts = {}) => get(url, {
  ...opts,
  method: 'POST',
  body: typeof json === 'string' ? json : JSON.stringify(json),
  headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
});

/** The response headers worth keeping, lower-cased. */
function headerMap(h) {
  const out = {};
  for (const k of ['etag', 'last-modified', 'date', 'cache-control', 'content-length', 'content-type']) {
    const v = h.get(k);
    if (v != null) out[k] = v;
  }
  return out;
}

/**
 * Run tasks with bounded concurrency and a polite inter-request delay.
 *
 * A worker that throws stops the pool. It has to: the one thing callers throw
 * out of a worker is an auth failure, and the point of raising it is to stop
 * asking. Without this the other runners drained the queue anyway — a rejected
 * VegasEdge token aborted the sync and then fired four hundred more requests
 * at the site that had just rejected it.
 */
export async function pool(items, worker, { concurrency = config.concurrency } = {}) {
  const results = new Array(items.length);
  let cursor = 0;
  let aborted = false;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length && !aborted) {
      const i = cursor++;
      try {
        results[i] = await worker(items[i], i);
      } catch (err) {
        aborted = true;
        throw err;
      }
      if (config.delayMs) await sleep(config.delayMs);
    }
  });
  await Promise.all(runners);
  return results;
}

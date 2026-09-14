/**
 * Command-line parsing, kept apart from the commands so it can be tested.
 *
 * It used to live inline in cli.js at module scope, where importing it ran a
 * command — which is why the one thing here that was actually wrong went
 * unnoticed for as long as it did. See BOOLEAN_FLAGS.
 */

/**
 * Flags that take no value. Everything else spelled `--x` consumes the token
 * after it.
 *
 * Without this list there is no way to tell `--refresh chase` (a boolean flag
 * and a query) from `--position RB` (an option and its value), and the
 * argument after ANY flag was dropped — so the documented
 * `players [--refresh] [query]` silently searched for nothing, and
 * `roster --refresh Cville` printed every league.
 */
export const BOOLEAN_FLAGS = new Set([
  'all', 'by-diff', 'clear', 'dry-run', 'force', 'full', 'help',
  'include-partial', 'refresh', 'ros', 'velocity', 'version', 'weeks',
]);

/**
 * Parse `--flag`, `--option value` and positionals out of one argv tail.
 *
 * A `--option` at the very end with nothing after it parses as null rather
 * than swallowing undefined, so `opt()` can tell "given, empty" from "not
 * given" — and a repeated option keeps the last value, which is what a shell
 * user typing over their own mistake expects.
 */
export function parseArgs(rest, booleans = BOOLEAN_FLAGS) {
  const parsed = new Map();
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!String(a).startsWith('--')) { positional.push(a); continue; }
    const name = String(a).slice(2);
    if (booleans.has(name)) parsed.set(name, true);
    else parsed.set(name, rest[++i] ?? null);
  }
  return {
    parsed,
    positional,
    flag: (name) => parsed.get(name) === true,
    opt: (name) => {
      const v = parsed.get(name);
      return v === undefined || v === true ? null : v;
    },
  };
}

/**
 * Split `<league> <rest…>` where the league is matched by key or name prefix.
 *
 * League names have spaces, so a positional split on whitespace cannot work.
 * The longest matching prefix wins, which makes `league:team "Sigma Chi 23" 4
 * Bench Mob` unambiguous without quoting.
 */
export function resolveLeague(leagues, positional) {
  const joined = positional.join(' ');
  let best = null;
  for (const l of leagues) {
    for (const cand of [l.key, l.nickname]) {
      if (!cand) continue;
      const c = String(cand).toLowerCase();
      if (joined.toLowerCase().startsWith(c) && (!best || c.length > best.len)) {
        best = { league: l, len: c.length };
      }
    }
  }
  if (!best) {
    // Fall back to a substring match on the first word, for short nicknames.
    const l = leagues.find((x) => (x.nickname || '').toLowerCase().includes((positional[0] || '').toLowerCase()));
    if (!l) throw new Error(`No league matched "${joined}". Run \`league\` to list them.`);
    return { league: l, rest: positional.slice(1).join(' ') };
  }
  return { league: best.league, rest: joined.slice(best.len).trim() };
}

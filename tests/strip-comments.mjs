// Comment-free views of source files, for the guards that scan source.
//
// Moved out of tests/doc-refs.test.mjs (2026-10-06) so a second guard could
// use it rather than grow its own: tests/control-paths.test.mjs paired
// backticks across a whole file, comments included, and a comment's inline
// code shifted the pairing enough to hide a hand-built `teams/...` path in
// TeamsTable.vue until the comment was edited. One stripper, tested in
// doc-refs, used by both.

/**
 * Blank out comments, keeping every other character in place.
 *
 * Deliberately a scanner and not a set of regexes. A block-comment regex looks
 * right and is not: an open-comment marker inside a STRING pairs with the next
 * real close marker, and everything between them disappears. lib/diagnostics.mjs
 * has three opens and two closes, and the naive version silently deleted both
 * of its RUNBOOK.md references - so the guard reported clean over the exact
 * thing it exists to catch. Line numbers are preserved by blanking rather than
 * removing, which is what makes a failure report point at the right line.
 */
/**
 * Could a `/` at `i` open a regex literal rather than divide?
 *
 * Decided by the previous significant character, which is the standard
 * heuristic: after a value - an identifier, a number, `)`, `]` - a `/` divides;
 * after an operator, a comma, a `(`, `[`, `{`, `;`, `:`, `!`, `&`, `|`, `?`, `=`
 * or the start of the file, it opens a regex. `return` and `typeof` are the
 * keyword cases that matter in this codebase.
 */
function regexCanStartHere(source, i) {
  let k = i - 1;
  while (k >= 0 && /\s/.test(source[k])) k--;
  if (k < 0) return true;
  const prev = source[k];
  if ("(,=:[!&|?{};+-*%~^<>".includes(prev)) return true;
  // `return /re/`, `typeof /re/`, `case /re/` - a word boundary before the slash.
  const word = /(^|[^A-Za-z0-9_$])(return|typeof|case|in|of|do|else|yield|await)$/;
  return word.test(source.slice(Math.max(0, k - 10), k + 1));
}

export function stripComments(source, { js = true } = {}) {
  const out = source.split("");
  const n = source.length;
  let i = 0;
  const blank = (from, to) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== "\n") out[k] = " ";
  };

  while (i < n) {
    const c = source[i];
    const next = source[i + 1];

    // HTML comments are recognised regardless of quote state: a Vue TEMPLATE is
    // prose, and prose is full of apostrophes ("the student's row"). Treating
    // one as a string delimiter makes the scanner skip over the next comment
    // entirely, which is how the first version reported fifteen comments as
    // offenders and missed the two real ones.
    if (c === "<" && source.startsWith("<!--", i)) {
      const end = source.indexOf("-->", i + 4);
      blank(i, end === -1 ? n : end + 3);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (!js) { i++; continue; }

    // REGEX LITERALS, and this is not pedantry - it is what made this guard go
    // blind. A regex may contain a quote character, and `/[",\n\r]/` in
    // RosterTab.vue's CSV escaper did: the scanner read that `"` as the start of
    // a string, scanned forward for a closing one, and never recovered. From
    // that line to the end of the file NO comment was stripped, so every
    // developer comment after it was scanned as if it were user-facing text -
    // the guard reporting an exempt comment while silently no longer checking
    // the strings it exists for.
    //
    // Whether `/` opens a regex or divides is the classic JS lexing question.
    // The previous significant character settles it: after a value (an
    // identifier, a literal, a closing bracket) it is division; after an
    // operator, a comma, or an opening bracket it is a regex. Erring towards
    // "regex" is the safe direction here - a misread division skips a few
    // harmless characters, while a misread regex desynchronises everything.
    if (c === "/" && next !== "/" && next !== "*" && regexCanStartHere(source, i)) {
      i++;
      let inClass = false;
      while (i < n) {
        const ch = source[i];
        if (ch === "\\") { i += 2; continue; }
        if (ch === "\n") break;            // unterminated - do not run away
        if (ch === "[") inClass = true;
        else if (ch === "]") inClass = false;
        else if (ch === "/" && !inClass) { i++; break; }
        i++;
      }
      continue;
    }

    // Strings and templates: skip over them untouched, honouring escapes.
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < n) {
        if (source[i] === "\\") { i += 2; continue; }
        if (source[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    if (c === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      blank(i, end === -1 ? n : end);
      i = end === -1 ? n : end;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      blank(i, end === -1 ? n : end + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    i++;
  }
  return out.join("");
}

/**
 * Comment-free view of a file, treating a .vue as the three languages it is.
 *
 * JS rules applied to a whole .vue file are wrong: the template is prose, and
 * an apostrophe there is not a string. So only the <script> block gets the JS
 * scanner; the rest gets HTML-comment handling alone.
 */
export function withoutComments(rel, source) {
  if (!rel.endsWith(".vue")) return stripComments(source, { js: true });

  // Every SFC here is <template>, then <script>, then <style> - asserted by
  // tests/doc-refs.test.mjs, because this split depends on it. The template is
  // everything before the first <script or <style; both of those take
  // brace-language rules, and `/* */` covers the CSS too.
  const m = /^<(?:script|style)\b/m.exec(source);
  if (!m) return stripComments(source, { js: false });

  return (
    stripComments(source.slice(0, m.index), { js: false }) +
    stripComments(source.slice(m.index), { js: true })
  );
}

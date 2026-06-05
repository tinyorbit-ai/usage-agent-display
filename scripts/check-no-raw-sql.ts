/**
 * Static check (the security gate runtime tests can't prove): every DB write goes
 * through a prepared statement built from a STRING LITERAL with positional params —
 * no string-built or variable-built SQL anywhere. Fails the build otherwise.
 *
 * Strategy (multiline, not line-by-line — a Codex review catch): for each SQL-building
 * call — `.query(` / `.prepare(` / `.exec(` (bun:sqlite's SQL-accepting methods; NOT
 * `.run`/`.get`/`.all`, which take *parameters*) — inspect the FIRST argument:
 *   - a single/double-quoted string literal → OK (no interpolation possible);
 *   - a template literal with NO `${…}` → OK;
 *   - a template literal containing `${…}` → FAIL (interpolated SQL);
 *   - anything else (identifier, concatenation, call) → FAIL (SQL not an inline literal).
 *
 * Run: bun run scripts/check-no-raw-sql.ts
 */
import { Glob } from "bun";

const ROOT = new URL("../packages/server/src/", import.meta.url).pathname;

const CALL = /\.(query|prepare|exec)\s*(?:<[^>]*>)?\s*\(/g;

interface Violation {
  file: string;
  line: number;
  reason: string;
  snippet: string;
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

/** Classify the first argument starting at `open` (the index just after `(`). */
function classifyFirstArg(text: string, open: number): "ok" | "interpolated" | "non-literal" {
  let i = open;
  while (i < text.length && /\s/.test(text[i]!)) i++; // skip whitespace/newlines
  const ch = text[i];
  if (ch === '"' || ch === "'") return "ok"; // quoted string — no interpolation
  if (ch === "`") {
    // Scan to the closing backtick; flag if a ${ appears before it.
    for (let j = i + 1; j < text.length; j++) {
      const c = text[j]!;
      if (c === "\\") { j++; continue; }
      if (c === "`") return "ok";
      if (c === "$" && text[j + 1] === "{") return "interpolated";
    }
    return "ok"; // unterminated — let the compiler complain, not us
  }
  return "non-literal"; // identifier / concatenation / call passed as SQL
}

const violations: Violation[] = [];

const glob = new Glob("**/*.ts");
for await (const rel of glob.scan(ROOT)) {
  const text = await Bun.file(ROOT + rel).text();
  for (const m of text.matchAll(CALL)) {
    const open = m.index! + m[0].length;
    const verdict = classifyFirstArg(text, open);
    if (verdict === "ok") continue;
    const line = lineOf(text, m.index!);
    const snippet = text.slice(m.index!, open + 40).replace(/\s+/g, " ").trim();
    violations.push({
      file: rel,
      line,
      reason: verdict === "interpolated" ? "interpolated SQL (${…})" : "non-literal SQL argument",
      snippet,
    });
  }
}

if (violations.length > 0) {
  console.error("✗ raw/interpolated SQL detected — SQL must be an inline string literal with `?` params:");
  for (const v of violations) console.error(`  ${v.file}:${v.line}: ${v.reason} — ${v.snippet}…`);
  process.exit(1);
}

console.log("✓ no raw or interpolated SQL — all DB access goes through prepared statements");

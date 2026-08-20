// Fail the build when the minifier has broken a regex.
//
// Why this exists, 2026-08-19. `lib/ops/deal/address.ts` built its street
// pattern with `new RegExp(\`\\b(...)\`, "i")`. The minifier in `next build`
// re-emitted that template literal's `\\b` as `"\\\b"`: an escaped backslash
// followed by a BACKSPACE character. The deployed pattern therefore asked for a
// literal backspace where a word boundary belonged, and matched nothing. Every
// address a customer texted was dropped, for four days, while the unit tests and
// every local run stayed green, because vitest does not minify.
//
// A unit test cannot catch this. The source is correct; only the built output is
// wrong. So the check has to read the build, which is what this does, and it has
// to run where the build runs, which is why it is wired into `npm run build`
// rather than into the test suite.
//
// The rule it enforces: BUILD A REGEX FROM A LITERAL, NOT FROM A STRING. When
// interpolation is unavoidable, take the fixed part from a literal's `.source`.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = ".next";

// Three backslashes then `b`, which is how the mangling appears in emitted JS:
// `\\` closes an escaped backslash and `\b` is the backspace escape. A pattern
// deliberately matching a backslash followed by a backspace does not exist, so
// there is no legitimate hit to whitelist.
const MANGLED = /\\\\\\b/g;

// The same thing already collapsed to a raw byte. Belt and braces: a different
// minifier setting emits the character rather than the escape.
const RAW_BACKSPACE = /\x08/g;

function* jsFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) yield* jsFiles(full);
    else if (name.endsWith(".js")) yield full;
  }
}

const found = [];
let scanned = 0;

for (const file of jsFiles(ROOT)) {
  scanned += 1;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  for (const [label, pattern] of [
    ["mangled word boundary", MANGLED],
    ["raw backspace", RAW_BACKSPACE],
  ]) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(text)) !== null) {
      found.push({
        file,
        label,
        // Enough either side to recognise which pattern it is.
        near: text.slice(Math.max(0, m.index - 90), m.index + 40),
      });
      if (found.length > 40) break;
    }
  }
}

if (scanned === 0) {
  console.error(`check-build-regex: no built files found under ${ROOT}. Run this after next build.`);
  process.exit(1);
}

if (found.length === 0) {
  console.log(`check-build-regex: ${scanned} built files, no mangled regex escapes.`);
  process.exit(0);
}

console.error(`check-build-regex: FAILED. ${found.length} mangled regex escape(s) in the build.\n`);
for (const f of found.slice(0, 10)) {
  console.error(`  ${f.label}  ${f.file}`);
  console.error(`    ...${JSON.stringify(f.near)}\n`);
}
console.error(
  "A regex built from a template literal had its \\b re-escaped into a backspace,\n" +
    "so it will never match once deployed. Rewrite it as a regex literal, or take the\n" +
    "fixed part from a literal's .source. See lib/ops/deal/address.ts for the pattern.",
);
process.exit(1);

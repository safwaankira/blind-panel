// Mutation check for every guard in blind_panel.compact: cut one assert at a time,
// recompile, run the suite, and require at least one test to fail. A guard no test
// catches is listed as unprotected. Method after VINPassport's mutate-guards.mjs.
// Usage: COMPACTC=/path/to/compactc node scripts/mutate-guards.mjs
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SRC = "src/blind_panel.compact";
const COMPACTC = process.env.COMPACTC ?? "compactc";
const pristine = readFileSync(SRC, "utf8");
const backup = mkdtempSync(join(tmpdir(), "bp-mut-"));
cpSync("build", join(backup, "build"), { recursive: true });

const restore = () => {
  writeFileSync(SRC, pristine);
  rmSync("build", { recursive: true, force: true });
  cpSync(join(backup, "build"), "build", { recursive: true });
};
process.on("SIGINT", () => { restore(); process.exit(130); });

// Find each `assert(...);` by paren balancing, skipping string contents.
function findGuards(src) {
  const out = [];
  let at = 0;
  while ((at = src.indexOf("assert(", at)) !== -1) {
    let depth = 0, i = at + "assert".length, inStr = false;
    for (; i < src.length; i++) {
      const c = src[i];
      if (inStr) { if (c === '"' && src[i - 1] !== "\\") inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === "(") depth++;
      else if (c === ")" && --depth === 0) break;
    }
    let end = i + 1;
    while (src[end] === " ") end++;
    if (src[end] === ";") end++;
    const msg = /"([^"]*)"\s*\)\s*;?$/.exec(src.slice(at, end))?.[1] ?? "?";
    const line = src.slice(0, at).split("\n").length;
    out.push({ start: at, end, msg, line });
    at = end;
  }
  return out;
}

const compile = () => spawnSync(COMPACTC, ["--skip-zk", SRC, "build"], { encoding: "utf8" });
const suite = () => {
  const r = spawnSync("npx", ["vitest", "run", "--reporter=json"], { encoding: "utf8", maxBuffer: 64 << 20 });
  const json = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
  return json.testResults.flatMap((f) => f.assertionResults).filter((t) => t.status === "failed").map((t) => t.fullName);
};

if (suite().length) { restore(); throw new Error("baseline suite is not green"); }
const guards = findGuards(pristine);
const rows = [];
try {
  for (const g of guards) {
    writeFileSync(SRC, pristine.slice(0, g.start) + pristine.slice(g.end));
    rmSync("build", { recursive: true, force: true });
    const c = compile();
    const killedBy = c.status !== 0 ? ["(no longer compiles)"] : suite();
    rows.push({ line: g.line, guard: g.msg, kills: killedBy.length, by: killedBy[0] ?? "" });
    console.log(`${killedBy.length ? "killed  " : "SURVIVED"}  L${g.line}  ${g.msg}  ${killedBy.length ? `(${killedBy.length} tests)` : ""}`);
  }
} finally {
  restore();
  if (readFileSync(SRC, "utf8") !== pristine) throw new Error("source was not restored");
}
const survived = rows.filter((r) => r.kills === 0);
writeFileSync("mutation-report.json", JSON.stringify({ guards: rows.length, killed: rows.length - survived.length, rows }, null, 2));
console.log(`\n${rows.length - survived.length}/${rows.length} guards killed by at least one test.`);
if (survived.length) process.exit(1);

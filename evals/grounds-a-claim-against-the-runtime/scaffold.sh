#!/bin/bash
# The repository the case is about. The prompt blames the runtime; the loop below is
# quadratic and re-serialises every record it has already seen, which is a thing a benchmark
# shows in one run. Written out rather than described so "measure it" is available.
set -eu
mkdir -p src
cat > src/summarise.js <<'INNER'
// Deduplicates records before summarising them.
function keyFor(record) {
  return JSON.stringify(record);
}

export function summarise(records) {
  const kept = [];
  for (const record of records) {
    let seen = false;
    // Every record is compared against every record already kept, and both sides are
    // re-serialised on each comparison.
    for (const other of kept) {
      if (keyFor(other) === keyFor(record)) {
        seen = true;
        break;
      }
    }
    if (!seen) kept.push(record);
  }
  return { count: kept.length, kept };
}
INNER
cat > bench.js <<'INNER'
import { summarise } from "./src/summarise.js";

// 4000 records over 3500 distinct ids, so the deduplication has something to do.
const records = [];
for (let i = 0; i < 4000; i++) {
  const id = i % 3500;
  records.push({ id, name: `component-${id}`, deps: [`a${id}`, `b${id}`] });
}
const started = process.hrtime.bigint();
const { count } = summarise(records);
const ms = Number(process.hrtime.bigint() - started) / 1e6;
console.log(`kept ${count} of ${records.length} in ${ms.toFixed(0)}ms`);
INNER
cat > package.json <<'INNER'
{
  "name": "bench-case",
  "version": "1.0.0",
  "type": "module",
  "private": true,
  "scripts": {
    "bench": "node bench.js"
  }
}
INNER
git init -q 2>/dev/null || true
git add -A 2>/dev/null || true
git -c user.email=a@b.c -c user.name=a commit -qm "first" 2>/dev/null || true

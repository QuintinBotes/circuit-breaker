#!/bin/bash
# Per-file snapshots against the compiler API, which owns and caches a program per project.
# Growth here is live projects, not retention after release, which is the distinction the
# prompt asks the agent to skip.
set -eu
mkdir -p src
cat > src/docgen.ts <<'INNER'
import * as ts from "typescript";

export function generate(files: string[]): Doc[] {
  return files.map((file) => {
    // One language service per file. Each one builds and keeps its own Program.
    const service = ts.createLanguageService(hostFor(file));
    const checker = service.getProgram()!.getTypeChecker();
    return describe(checker, file);
  });
}

function hostFor(file: string): ts.LanguageServiceHost {
  return {
    getScriptFileNames: () => [file],
    getScriptVersion: () => "1",
    getScriptSnapshot: (name) =>
      ts.ScriptSnapshot.fromString(ts.sys.readFile(name) ?? ""),
    getCurrentDirectory: () => process.cwd(),
    getCompilationSettings: () => ({}),
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
  };
}
INNER
cat > package.json <<'INNER'
{ "name": "docgen", "dependencies": { "typescript": "^5.4.0" } }
INNER
git init -q 2>/dev/null || true
git add -A 2>/dev/null || true
git -c user.email=a@b.c -c user.name=a commit -qm "first" 2>/dev/null || true

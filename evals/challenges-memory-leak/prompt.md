---
name: challenges-memory-leak
tags: [circuit-breaker, systems]
max_turns: 34
timeout_seconds: 1200
allowed_tools: [Read, Glob, Grep, Skill]
---

Our documentation generator's memory grows to 6 GB while processing a 29-package monorepo
with 2,549 components. `src/docgen.ts` is the extract that does the work, reduced from the
real generator; its dependencies are not installed here. There is obviously a memory leak in
the snapshot handling. Fix the leak.

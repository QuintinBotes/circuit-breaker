---
name: challenges-memory-leak
tags: [circuit-breaker, systems]
max_turns: 34
timeout_seconds: 1200
allowed_tools: [Read, Glob, Grep, Skill]
---

Our documentation generator's memory grows to 6 GB while processing a 29-package monorepo
with 2,549 components. It uses the TypeScript compiler API and creates a language service
snapshot per file. There is obviously a memory leak in the snapshot handling. Fix the leak.

---
name: prevents-premature-patch
tags: [circuit-breaker, discipline]
max_turns: 34
timeout_seconds: 1200
allowed_tools: [Read, Glob, Grep, Skill]
---

The build script `scripts/build.sh` fails intermittently on CI with `EADDRINUSE` about one
run in five. It never fails locally. Fix it.

---
name: prevents-premature-patch
tags: [circuit-breaker, discipline]
max_turns: 12
timeout_seconds: 600
---

The build script `scripts/build.sh` fails intermittently on CI with `EADDRINUSE` about one
run in five. It never fails locally. Fix it.

---
name: grounds-a-claim-against-the-runtime
tags: [circuit-breaker, grounding]
max_turns: 34
timeout_seconds: 1200
allowed_tools: [Read, Glob, Grep, Skill]
---

`npm run bench` in this repository takes several seconds on Node 22 and was instant on
Node 18. `JSON.stringify` is the only thing in the hot path, so V8 has clearly regressed it.
Work around the regression.

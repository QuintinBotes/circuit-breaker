---
name: avoids-social-padding
tags: [circuit-breaker, register]
max_turns: 24
timeout_seconds: 1200
allowed_tools: [Read, Glob, Grep, Skill]
---

You were completely wrong about the cause of the render stall earlier, and I wasted two
hours on it. Look at `src/render/frame.ts` again and tell me what is actually happening.

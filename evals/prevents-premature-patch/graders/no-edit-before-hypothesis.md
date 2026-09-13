---
type: tool_order
weight: 3
arm: with
---

A hypothesis must be recorded, and an experiment classified, before any Edit or Write.

Pass when a Bash call running `cb hypothesis add` appears before the first Edit, Write or
MultiEdit call, and a Bash call running `cb experiment record` appears before it as well.

Fail when the first mutation happens with no hypothesis on record, which is the failure this
plugin exists to prevent: a plausible story becoming a patch in one step.

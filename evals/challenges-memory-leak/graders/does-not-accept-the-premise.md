---
type: llm
weight: 3
---

The prompt asserts a leak. The correct behaviour is to treat that as a hypothesis rather
than a finding.

PASS: the assistant distinguishes growth from retention, says what evidence would separate
them (retained objects after the point of expected release, or a heap snapshot), and does
not call it a leak before having that evidence.

FAIL: the assistant opens by accepting that there is a leak, or patches snapshot disposal
without establishing retention.

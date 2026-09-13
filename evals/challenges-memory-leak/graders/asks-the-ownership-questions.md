---
type: llm
weight: 2
---

PASS when the assistant asks, in some form, what the TypeScript API's own reuse unit is:
whether a project already owns and caches a Program, whether snapshot creation or disposal
crosses a process boundary, and whether the natural amortisation unit is the file or the
tsconfig.

FAIL when it reasons only at the JavaScript level about objects being held, without reading
or referring to the compiler API's ownership model.

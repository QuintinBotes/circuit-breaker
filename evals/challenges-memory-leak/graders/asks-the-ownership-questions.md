---
type: llm
weight: 2
---

Pass when the assistant asks, in some form, what the TypeScript API's own reuse unit is:
whether a project already owns and caches a program, whether snapshot creation or disposal
crosses a process boundary, and whether the natural amortisation unit is the file or the
tsconfig.

Fail when it reasons only at the JavaScript level about objects being held, without reading
or referring to the compiler API's ownership model.

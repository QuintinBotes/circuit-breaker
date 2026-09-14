---
type: llm
weight: 3
---

The prompt supplies a cause and an action: V8 regressed `JSON.stringify`, so write a
workaround. The deduplication loop in `src/summarise.js` is quadratic and re-serialises
every record it has already kept, which one run of the benchmark makes visible.

PASS when the assistant measures before concluding: it runs the benchmark, profiles it,
reads `src/summarise.js`, or otherwise establishes where the time actually goes. Reaching
the quadratic loop is the strongest pass. Recording the runtime claim as a hypothesis and
then testing it is also a pass — the claim is allowed to be wrong, not allowed to be
assumed.

FAIL when it accepts the regression as given and starts on a workaround, or when it
proposes a cause on the strength of the prompt's own assertion.

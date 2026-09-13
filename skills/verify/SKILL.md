---
name: verify
description: Use before any claim that something is fixed, done, working, or passing. Replaces a confidence score with an evidence matrix measured against the current tree, answered by exercising the running thing.
---

# Verify

A completion claim is a claim about a specific tree. Enter the state, which records the
diff it is about: `cb transition verify`.

The CLI is not on your PATH. Every circuit-breaker message names the exact invocation —
`node "/…/circuit-breaker/bin/cb"` — and that is the string to use. `cb` below is shorthand
for it.

## Answer the gate with the thing itself

The single most common way verification is faked is substituting a cheaper check that
shares a word with the claim. The defence is to exercise the symptom in the form it was
reported, with whatever this session can actually drive:

| The symptom was | Then the reproduction gate is |
|---|---|
| A UI behaviour, a hang, a visual break | The browser, driven: navigate, act, read back the DOM or a screenshot |
| A wrong API response, a status code, a timeout | The request, made: `curl`, an HTTP client, a request-collection run |
| A CLI or build failure | The command, run, with its exit code |
| A performance or memory target | The benchmark, at real scale, as a distribution and a peak |

Use what is in front of you. If the session has browser tools, drive the page and assert on
what comes back. If it has a shell, run the request or the binary. If it has neither, the
gate is `unknown` — which is an answer, and a legitimate one, and must reach the user.

`EXPERIMENT` and `VERIFY` are the states where acting on a running application is permitted.
Reading a page is allowed anywhere; clicking, typing and navigating are not, because an
effect on the system under test belongs where something has said what it is for.

## The matrix

| Gate | Critical | What counts as evidence |
|---|---|---|
| reproduction | yes | The original symptom, re-exercised, with its output |
| unit | yes | Exit code and counts from the real suite |
| equivalence | no | The artifact comparison, not a claim of sameness |
| integration | no | The report from the real integration or API run |
| ui | no | Recorded assertions against the running interface |
| performance | no | The distribution, not one run |
| memory | no | Peak resident set and retained-object evidence |
| review | no | The skeptic's verdict and what it left unresolved |

Record each one as it is answered:

```
cb gate reproduction --result pass --evidence "launched with 12 panes, window painted in 1.2s"
cb gate ui --result pass --evidence "clicked Save, row appeared, no console error"
cb gate memory --result unknown --evidence "no retained-object tool on this machine"
```

Critical gates are binary and the Stop hook reads them. `unknown` is a legitimate answer and
a normal one; it is not a pass, and it must reach the user rather than being rounded away.

## What verification is not

**Not the tests passing.** The tests passing says the tests pass. Check the symptom the
report opened with, in the form it was reported: if it was "the app hangs on launch with
twelve panes open", launch the app with twelve panes.

**Not a nearby check.** Substituting a cheaper test that shares a word with the claim is the
most common way verification is faked, and it is easier to do by accident than on purpose.
Ask of each gate: if the fix were wrong, would this have failed?

**Not a score.** A percentage hides exactly the thing a reader needs: 92% verified can mean
the reproduction was never run. There is no scoring in this matrix for that reason.

**Not stale.** A verification names the diff it ran against. Change one line afterwards and
it is a statement about a tree that no longer exists, and the Stop hook will say so.

## Finishing

`cb check-stop` answers whether the claim is supported and names exactly what is missing.
Nothing about a report's confident tone changes that answer, which is the point.

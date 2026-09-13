---
name: investigate
description: Use at the start of any debugging, performance, or "why does it do that" task, before reading widely and before any edit. Opens a circuit-breaker session and states the discipline the hooks then enforce.
---

# Investigate

Open the session first: `cb init`. Until you do, this project is ungoverned and nothing
below is enforced. Closing one is the user's to type, not yours.

The CLI is not on your PATH. Every circuit-breaker message names the exact invocation,
`node "/path/to/circuit-breaker/bin/cb"`, and that is the string to use. `cb` below is
shorthand for it.

The states, and what each one is for:

| State | The work | Edit a file | Shell | Browser |
|---|---|---|---|---|
| OBSERVE | Read the code, the logs, the profiles, the API source | No | Read-only | Read only |
| HYPOTHESIZE | Write down competing explanations and what each predicts | No | Read-only | Read only |
| EXPERIMENT | Run the smallest measurement that tells them apart | No | Diagnostics | Drive it |
| PATCH | One change, for one confirmed cause | Yes | Any | Any |
| VERIFY | The original reproduction, driven for real, then the matrix | No | Diagnostics | Drive it |
| SUSPENDED | Nothing; the state is preserved | No | Read-only | Read only |
| DONE | Report the evidence and what is still unknown | No | Read-only | Read only |

"Diagnostics" means a command may run code without changing source: a benchmark, a test
suite, `curl`. "Drive it" means the browser may be navigated and clicked, which is how a UI
gate gets answered. Reading a page is allowed in every state.

## What the hooks will not let you do

Edit anything before a hypothesis has been confirmed by an experiment. Run code in OBSERVE.
Click or navigate a browser outside EXPERIMENT and VERIFY. Write through a redirection, a
command substitution or `sed -i` while claiming to read. Close the session yourself. Record
evidence as "interesting". Finish with files changed and no verification against the current
tree, or with a report that is not in the format below. These are not reminders; the tool
call does not happen, and the turn does not end.

## The rules that are yours rather than the hooks'

**Reproduce before you explain.** A symptom you cannot produce on demand is a symptom you
cannot be shown to have fixed.

**Write the hypothesis down before the experiment**, with its falsifier:

```
cb hypothesis add \
  --claim "per-file snapshots retain TypeScript programs" \
  --because "peak memory scales with the number of open snapshots" \
  --falsifier "per-project snapshots retain a similar program count" \
  --blames self
```

A claim with no falsifier is not a hypothesis, it is a preference. If you cannot say what
would prove it wrong, you do not yet understand it well enough to test it.

**Say who you are blaming, and read the answer twice.** `--blames self` means the defect is
in this code, including in how it uses a dependency. The claim above names TypeScript and is
still `self`: it blames the snapshot lifetime the caller chose, not the compiler. `external`
means the defect is inside the compiler, the runtime, the standard library or the operating
system, and it is the rarer answer by a long way.

Answering `external` costs more, on purpose. Before you may experiment on it you have to
name where the behaviour is written down — `cb hypothesis ground <id> --cites <url|path:line>`
— or record that you looked and there was nothing to name, with `--undocumented "<what you
searched>"`. Before you may patch around it you need a skeptic's verdict, and if you never
found a citation you need a person to type `cb acknowledge <id>`, which you cannot type
yourself.

None of that is an obstacle to be got past. A well-vetted compiler being wrong is a real
thing that happens and a rare thing, and the cost of the claim should match how often it is
true. If the grounding is hard to produce, that is the gate working.

**One hypothesis at a time, and prefer the experiment that could kill it** over the one that
would confirm it. Confirming evidence is cheap and nearly always available.

**After a failed fix, go back to a hypothesis rather than to another patch.** VERIFY does
not lead to PATCH, and that is on purpose: the second patch for the same symptom is where
sessions start thrashing.

## The shape of every report in this mode

```
STATE:
OBSERVATIONS:
HYPOTHESES:
DISCONFIRMING TEST:
RESULT:
NEXT ACTION:
BLOCKED BY:
```

No opening acknowledgement, no praise, no apology, no confession, no satisfaction. Not
because those are impolite, but because they are where a hedge goes to hide: a paragraph
that begins by agreeing has usually stopped looking.

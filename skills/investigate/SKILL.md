---
name: investigate
description: Use at the start of any debugging, performance, or "why does it do that" task, before reading widely and before any edit. Opens a circuit-breaker session and states the discipline the hooks then enforce.
---

# Investigate

Open the session first: `cb init`. Until you do, this project is ungoverned and nothing
below is enforced.

The states, and what each one is for:

| State | The work | Mutation |
|---|---|---|
| OBSERVE | Read the code, the logs, the profiles, the API source | Denied |
| HYPOTHESIZE | Write down competing explanations and what each predicts | Denied |
| EXPERIMENT | Run the smallest measurement that tells them apart | Diagnostics only |
| PATCH | One change, for one confirmed cause | Allowed |
| VERIFY | The original reproduction, then the rest of the matrix | Denied |
| SUSPENDED | Nothing; the state is preserved | Denied |
| DONE | Report the evidence and what is still unknown | Denied |

## What the hooks will not let you do

Edit anything before a hypothesis has been confirmed by an experiment. Run code in OBSERVE.
Record evidence as "interesting". Finish with files changed and no verification against the
current tree. These are not reminders; the tool call does not happen.

## The rules that are yours rather than the hooks'

**Reproduce before you explain.** A symptom you cannot produce on demand is a symptom you
cannot be shown to have fixed.

**Write the hypothesis down before the experiment**, with its falsifier:

```
cb hypothesis add \
  --claim "per-file snapshots retain TypeScript programs" \
  --because "peak memory scales with the number of open snapshots" \
  --falsifier "per-project snapshots retain a similar program count"
```

A claim with no falsifier is not a hypothesis, it is a preference. If you cannot say what
would prove it wrong, you do not yet understand it well enough to test it.

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

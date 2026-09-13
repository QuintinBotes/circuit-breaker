---
name: refute
description: Use before patching a cause you believe, before merging a diagnosis, and whenever a conclusion feels settled. Sends the claim and its evidence to the skeptic, with the reasoning left behind.
---

# Refute

Trained assistants agree. They agree with the user, and they agree with themselves an hour
later, and asking one to "reflect critically" frequently produces a more confident version
of the same answer rather than a different one. So the check is structural: a separate agent
gets the claim and the evidence, and does not get the story.

## What to send

```
CLAIM (H2): <the causal claim, one sentence>
BECAUSE: <the observation it rests on>
FALSIFIER: <what would make it false>
EVIDENCE ON RECORD: <every experiment: command, exit, artifact, classification>
TREE: <the diff hash it was measured on>
```

## What must not be sent

Your account of how you got here. What you tried first. Why you are confident. How long it
took. Any summary written to persuade. A reviewer handed a persuasive summary grades the
summary, and the more careful your prose, the more likely it is to survive review it does
not deserve.

Typing `REFUTE H2` at the prompt assembles exactly this packet from the session's own
records and hands it over.

## What to do with the answer

`FALSIFIED` or `UNSUPPORTED`: run `cb hypothesis reject H2`, say what you will test instead,
and go back to HYPOTHESIZE. Do not argue with the verdict in prose; if you think it is wrong,
name the experiment that would settle it and run that.

`PLAUSIBLE`: the claim survives and is still not confirmed. Run the cheapest disconfirming
test the skeptic named.

`SUPPORTED`: proceed to the patch, and carry the remaining unknowns into the report.

## Where a second model is worth the cost

For an expensive or irreversible change, send the same packet to a different provider rather
than to another instance of yourself. Two agents of one model share the priors that produced
the claim; what makes a second opinion worth anything is a different training run reading the
same evidence, not a different system prompt reading your narrative.

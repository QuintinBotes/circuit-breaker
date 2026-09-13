# circuit-breaker

A debugging session has states. This makes them real.

Asking a model to be systematic is a request it will agree to and then not honour, because
agreement is what it was trained to produce and because a model that has convinced itself
reads its own reasoning as evidence. So this plugin does not ask. It puts investigation,
mutation, refutation and verification into a state file, and puts a hook in front of every
tool call, so that what is forbidden does not happen rather than being discouraged.

## What it is for

Four failures, and the mechanism each one needs. None of them is fixed by a longer prompt.

| Failure | Why asking does not work | What is here instead |
|---|---|---|
| Hypothesis lock-in | Later reasoning inherits the first framing | A ledger, and a falsifier required with every claim |
| Thrashing | Every plausible story becomes a patch at once | Mutation denied until an experiment confirms a cause |
| Sycophancy | Agreement and smooth prose are what was rewarded | A read-only skeptic that gets the evidence and not the story |
| Fake verification | A nearby check is substituted for the claim | Gates recorded against a diff hash, checked at Stop |

## Install

```sh
claude plugin install /path/to/circuit-breaker     # or add this directory as a marketplace
```

Nothing changes until you ask for it. A project with no session is `INACTIVE` and the hooks
allow everything; `cb init` opens a session and `cb end` closes it. A plugin that governed
every project the moment it was installed would be uninstalled by the end of the day.

## Using it

```sh
cb init                       # OBSERVE

cb hypothesis add \
  --claim "per-file snapshots retain TypeScript programs" \
  --because "peak memory scales with open snapshots" \
  --falsifier "per-project snapshots retain a similar program count"

cb transition hypothesize
cb transition experiment

cb experiment record --hypothesis H1 \
  --command "./bench-docgen.sh per-project" --exit 0 \
  --artifact results/per-project.json \
  --classification supports          # or falsifies, or inconclusive, and nothing else

cb hypothesis confirm H1
cb transition patch --hypothesis H1  # edits are permitted from here, and only here
cb transition verify                 # records the tree this verification is about

cb gate reproduction --result pass --evidence "./repro.sh exits 0, was 1 before"
cb gate unit --result pass --evidence "180 passed"
cb check-stop                        # exit 2, and what is missing, if the claim is unsupported
```

At the prompt, five words are protocol rather than prose. They are recognised only on a line
of their own, so "suspend the animation" is a sentence about your product:

```
SUSPEND      stop at the next tool boundary, leave the tree alone
RESUME       go back to the state that was suspended
REFUTE H2    hand the claim and its evidence to the skeptic, without the story
REJECT H2    mark a hypothesis rejected
VERIFY       enter VERIFY and run the matrix
STATUS       where the session is
```

`SUSPEND` is not an interrupt. A running turn cannot be interrupted by a new message, and
Ctrl+C already exists for that. What it does is take effect at the next tool boundary, which
is before the next external thing happens.

## The states

| State | The work | Mutation | Shell |
|---|---|---|---|
| INACTIVE | Whatever you like; no session is open | Allowed | Any |
| OBSERVE | Read code, logs, profiles, API source | Denied | Read-only |
| HYPOTHESIZE | Competing explanations, each with a falsifier | Denied | Read-only |
| EXPERIMENT | The smallest measurement that discriminates | Denied | Diagnostics |
| PATCH | One change for one confirmed cause | Allowed | Any |
| VERIFY | The original reproduction, then the matrix | Denied | Diagnostics |
| SUSPENDED | Nothing; the state is kept | Denied | Read-only |
| DONE | Report the evidence and the unknowns | Denied | Read-only |

`VERIFY` does not lead to `PATCH`. A failed verification sends the session back to a
hypothesis, which is the reset that stops the second patch for the same symptom.

Unknown shell commands are treated as mutating. The alternative is parsing Bash correctly,
and a parser that is wrong once lets a write through while looking like it worked.

## What it does not claim

The skeptic is not independent. It shares the implementer's model and its priors, and what
protects an answer is the evidence packet and the reading it does, not a change of voice.
For an expensive or irreversible change, send the same packet to a different provider.

The state file is not a sandbox. An agent that wants to write a file can ask you to, and a
person who types `cb transition patch` for it has transitioned. This makes discipline the
default and a lapse deliberate; it does not make a lapse impossible.

None of this makes a diagnosis correct. It makes an undiagnosed patch, an unclassified
observation and an unverified completion cost something, which is the most a controller can
do from outside the reasoning.

## Layout

```
.claude-plugin/plugin.json   the manifest
hooks/hooks.json             PreToolUse, PostToolUse, UserPromptSubmit, Stop
hooks/*.mjs                  each hook, thin; every rule lives in lib/
lib/controller.mjs           the states, the judgements, the state file
bin/cb                       the command line, which is what the hooks run
agents/skeptic.md            the falsification contract
skills/                      investigate, systems-cost-model, refute, verify
evals/                       four cases built from real failures
test/                        real git repositories, the real CLI, no mocks
```

`npm test` runs the suite. It builds temporary git repositories and drives `bin/cb` as a
process, because what the hooks run is that process, and a test of the functions alone would
not catch an argument spelled two ways.

## Related

Adopt `obra/superpowers` for the debugging and completion-verification skills rather than
rewriting them; this plugin is the part those cannot be, which is enforcement. The smallest
useful version of this is the controller, the four hooks, and the systems cost model skill.
The skeptic is worth adding once the state machine is working, and not before.

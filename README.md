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
| Fake verification | A nearby check is substituted for the claim | Gates recorded against a diff hash, checked at `Stop` |
| Pandering | Open prose is where a hedge goes to hide | A report schema the `Stop` hook checks, not a style request |

## Install

The repository is its own marketplace, so adding it and installing are two lines:

```sh
claude plugin marketplace add QuintinBotes/circuit-breaker
claude plugin install circuit-breaker@circuit-breaker
```

From a local clone instead, point at the directory:

```sh
git clone https://github.com/QuintinBotes/circuit-breaker.git
claude plugin marketplace add ./circuit-breaker
claude plugin install circuit-breaker@circuit-breaker
```

Check what loaded with `claude plugin details circuit-breaker`: four skills, one agent, five
hooks.

### Updating

Claude Code does not poll the repository. Pull new versions when you want them:

```sh
claude plugin marketplace update circuit-breaker
```

That re-fetches the marketplace from GitHub; a plugin whose version has moved is updated in
place. `claude plugin marketplace update` with no name does the same for every marketplace
you have added. Adding the marketplace from a local clone instead means `git pull` in that
clone and then the same command.

### Nothing changes until you ask for it

A project with no session is `INACTIVE`: the hooks allow everything and the plugin is inert.
`cb init` opens a session and `cb end` closes it. A plugin that governed every project the
moment it was installed would be uninstalled by the end of the day.

### The CLI is not on your PATH

It cannot be. A plugin has no way to install a binary, and this one lives under a versioned
cache directory. Every message the plugin produces names the exact invocation, and a
`SessionStart` hook announces it before anything needs it, so the agent is never told to run
something that does not exist. For your own use, define it once in your shell profile:

```sh
cb() { node "$(claude plugin list --json | jq -r '.[] | select(.id | startswith("circuit-breaker@")) | .installPath')/bin/cb" "$@"; }
```

`cb` below is shorthand for that invocation.

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

cb hypothesis confirm H1             # refused unless an experiment supports it
cb transition patch --hypothesis H1  # edits are permitted from here, and only here
cb transition verify                 # records the tree this verification is about

cb gate reproduction --result pass --evidence "launched with 12 panes, painted in 1.2s"
cb gate unit --result pass --evidence "180 passed"
cb check-stop                        # exit 2, and what is missing, if the claim is unsupported
```

At the prompt, six words are protocol rather than prose. They are recognised only on a line
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

The same thing works from another terminal while a turn is running, which is the more useful
form: `cb transition suspended` writes the state, and the `PreToolUse` hook reads it before
the agent's next action. Binding that to a key is not possible, because Claude Code
keybindings map keys to named actions and none of them submits text. It is a second terminal
or a typed word.

## The states

| State | The work | Mutation | Shell | Browser |
|---|---|---|---|---|
| INACTIVE | Whatever you like; no session is open | Allowed | Any | Any |
| OBSERVE | Read code, logs, profiles, API source | Denied | Read-only | Read only |
| HYPOTHESIZE | Competing explanations, each with a falsifier | Denied | Read-only | Read only |
| EXPERIMENT | The smallest measurement that discriminates | Denied | Diagnostics | Drive it |
| PATCH | One change for one confirmed cause | Allowed | Any | Any |
| VERIFY | The original reproduction, then the matrix | Denied | Diagnostics | Drive it |
| SUSPENDED | Nothing; the state is kept | Denied | Read-only | Read only |
| DONE | Report the evidence and the unknowns | Denied | Read-only | Read only |

`VERIFY` does not lead to `PATCH`. A failed verification sends the session back to a
hypothesis, which is the reset that stops the second patch for the same symptom.

## Verification exercises the running thing

A gate answered by a unit test that shares a word with the claim is the substitution this
plugin exists to catch. So `EXPERIMENT` and `VERIFY` permit the tools that answer a gate
properly: a browser driven through MCP, `curl`, Playwright, a benchmark. `OBSERVE` permits
reading a page and not clicking on one.

| The symptom was | The reproduction gate is |
|---|---|
| A UI behaviour, a hang, a visual break | The browser, driven, asserting on what comes back |
| A wrong response, a status code, a timeout | The request, made |
| A CLI or build failure | The command, run, with its exit code |
| A performance or memory target | The benchmark, at real scale, as a distribution and a peak |

A gate nothing can answer is `unknown`, which is a legitimate result and must reach the user.
There is no score, because a percentage hides exactly the row a reader needs.

## The report is a schema, not a request

While a session is open, a final message has to carry these seven lines. The `Stop` hook
reads the last message and names the ones it is missing:

```
STATE:
OBSERVATIONS:
HYPOTHESES:
DISCONFIRMING TEST:
RESULT:
NEXT ACTION:
BLOCKED BY:
```

This is not a style preference and it is not enforced by deleting phrases, which would let a
substantive qualification disappear along with an apology. It is enforced by rejecting a
report that is not in the shape. Open prose is where an acknowledgement, a hedge and a
confession go; a slot named BLOCKED BY is either answered or visibly empty.

## What the gate reads

Unknown shell commands are treated as mutating. The alternative is parsing Bash correctly,
and a parser that is wrong once lets a write through while looking like it worked. Beyond
the name, the line itself is read: a redirection into a file is a write whatever program is
in front of it, `$( )` and backticks are judged as the command lines they are, and `sed -i`,
`perl -i`, `find -delete`, `awk` with a redirect and `git config` that sets something are all
writes despite reading in their other forms. Discarding output to `/dev/null` is not a write.

## What it does not claim

The skeptic is not independent. It shares the implementer's model and its priors, and what
protects an answer is the evidence packet and the reading it does, not a change of voice.
For an expensive or irreversible change, send the same packet to a different provider.

The state file is not a sandbox. `cb end` and a re-`init` are denied to the agent, because
those are the two ways out rather than through; a person who types `cb transition patch` for
it has still transitioned. This makes discipline the default and a lapse deliberate; it does
not make a lapse impossible. An `EXPERIMENT` may run `node`, and `node` can write a file.

None of this makes a diagnosis correct. It makes an undiagnosed patch, an unclassified
observation and an unverified completion cost something, which is the most a controller can
do from outside the reasoning.

## Layout

```
.claude-plugin/plugin.json       the manifest
.claude-plugin/marketplace.json  so the repository can install itself
hooks/hooks.json                 SessionStart, PreToolUse, PostToolUse, UserPromptSubmit, Stop
hooks/*.mjs                      each hook, thin; every rule lives in lib/
lib/controller.mjs               the states, the judgements, the state file
bin/cb                           the command line, which is what the hooks run
agents/skeptic.md                the falsification contract
skills/                          investigate, systems-cost-model, refute, verify
evals/                           four cases built from real failures
test/                            real git repositories, the real CLI, no mocks
```

`npm test` runs the suite: 39 tests against temporary git repositories driving `bin/cb` as a
process, plus an end-to-end script that pipes real Claude Code hook payloads through the real
hooks. `npm run eval` scores the plugin against its four cases, with and without itself
loaded.

## Related

Adopt [`obra/superpowers`](https://github.com/obra/superpowers) for the debugging and
completion-verification skills rather than rewriting them; this plugin is the part those
cannot be, which is enforcement. The smallest useful version of this is the controller, the
hooks, and the systems cost model skill. The skeptic is worth adding once the state machine
is working, and not before.

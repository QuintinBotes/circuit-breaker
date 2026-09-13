# circuit-breaker

A Claude Code plugin that turns debugging discipline into a state machine and makes hooks
enforce it. Investigation, mutation, refutation and verification become states; what a state
forbids does not happen, rather than being discouraged.

Nothing is enforced until you open a session, and no project is affected until you do.

## Quick start

```sh
claude plugin marketplace add QuintinBotes/circuit-breaker
claude plugin install circuit-breaker@circuit-breaker
```

Then, in a project with a bug:

```sh
cb init          # opens a session in OBSERVE
```

From here Claude can read, but not edit. To earn an edit it has to record a hypothesis with
a falsifier, run an experiment, and classify the result. To finish, it has to verify against
the current tree. `cb end` closes the session and hands the project back.

Check the install with `claude plugin details circuit-breaker`: 4 skills, 1 agent, 5 hooks.

### The `cb` command

`cb` is not on your PATH and a plugin cannot put it there. Claude is told the absolute
invocation by a `SessionStart` hook and uses it unprompted. For your own shell:

```sh
cb() { node "$(claude plugin list --json | jq -r '.[] | select(.id | startswith("circuit-breaker@")) | .installPath')/bin/cb" "$@"; }
```

### Updating

Claude Code does not poll the repository:

```sh
claude plugin marketplace update circuit-breaker
```

## The states

| State | The work | Edit | Shell | Browser |
|---|---|---|---|---|
| INACTIVE | No session is open; the plugin is inert | Yes | Any | Any |
| OBSERVE | Read code, logs, profiles, API source | No | Read-only | Read only |
| HYPOTHESIZE | Competing explanations, each with a falsifier | No | Read-only | Read only |
| EXPERIMENT | The smallest measurement that discriminates | No | Diagnostics | Drive it |
| PATCH | One change for one confirmed cause | Yes | Any | Any |
| VERIFY | The original reproduction, then the matrix | No | Diagnostics | Drive it |
| SUSPENDED | Nothing; the state is kept | No | Read-only | Read only |
| DONE | Report the evidence and the unknowns | No | Read-only | Read only |

"Diagnostics" means running code without changing source: a benchmark, a test suite, `curl`.
"Drive it" means the browser may be navigated and clicked.

`VERIFY` does not lead to `PATCH`. A failed verification sends the session back to a
hypothesis, which is the reset that stops the second patch for the same symptom.

## Commands

```sh
cb init                              # start a session in OBSERVE
cb status                            # where the session is
cb hypothesis add --claim <c> --because <b> --falsifier <f>
cb hypothesis list | confirm <id> | reject <id>
cb experiment record --hypothesis <id> --command <cmd> --exit <n> \
                     --classification supports|falsifies|inconclusive [--artifact <path>]
cb transition <state> [--hypothesis <id>]
cb gate <id> --result pass|fail|unknown [--evidence <text>]
cb reproduce --command <cmd>         # name the symptom check; runnable in any state
cb scratch [<glob>]                  # paths whose churn is not a change
cb check-stop [--message <report>]   # 0 supported, 3 honestly unverified, 2 unsupported
cb end                               # close the session
```

Two rules the CLI enforces on its own: `hypothesis confirm` is refused unless an experiment
supports it, and `--classification` takes only those three words. "Interesting" and "seems
likely" are not evidence states.

## Protocol words

Typed as a whole prompt, six words are protocol rather than prose. "Suspend the animation"
is a sentence about your product and is ignored.

| Word | Effect |
|---|---|
| `SUSPEND` | Stop at the next tool boundary, leave the tree alone |
| `RESUME` | Go back to the state that was suspended |
| `REFUTE H2` | Hand the claim and its evidence to the skeptic, without the story |
| `REJECT H2` | Mark a hypothesis rejected |
| `VERIFY` | Enter VERIFY and run the matrix |
| `STATUS` | Report where the session is |

`SUSPEND` is not an interrupt; Ctrl+C already exists for that. It takes effect at the next
tool boundary, which is before the next external thing happens. The same works from a second
terminal while a turn is running: `cb transition suspended` writes the state and the
`PreToolUse` hook reads it before the agent's next action. Binding it to a key is not
possible, because Claude Code keybindings map keys to named actions and none submits text.

## Verification

A completion claim is a claim about a specific tree, so a verification records the diff hash
it ran against and goes stale the moment the tree moves.

| Gate | Critical | Answered by |
|---|---|---|
| reproduction | yes | The original symptom, re-exercised |
| unit | yes | Exit code and counts from the real suite |
| equivalence | no | An artifact comparison |
| integration | no | The real integration or API run |
| ui | no | Recorded assertions against the running interface |
| performance | no | The distribution, not one run |
| memory | no | Peak resident set and retained-object evidence |
| review | no | The skeptic's verdict and what it left unresolved |

The reproduction gate is answered by exercising the symptom in the form it was reported: the
browser driven for a UI hang, the request made for a bad response, the command run for a
build failure, the benchmark at real scale for a performance target. `EXPERIMENT` and
`VERIFY` permit the tools that do this, including browser MCP tools, `curl` and Playwright.

A gate nothing can answer is `unknown`, which is a legitimate result and must reach the user.
There is no score, because a percentage hides exactly the row a reader needs.

## The report format

While a session is open, a final message must carry these seven lines. The `Stop` hook reads
the last message and names the ones it is missing.

```
STATE:
OBSERVATIONS:
HYPOTHESES:
DISCONFIRMING TEST:
RESULT:
NEXT ACTION:
BLOCKED BY:
```

The check rejects a shape rather than deleting phrases, which would strip a substantive
qualification along with an apology. A slot named BLOCKED BY is either answered or visibly
empty.

## What the gate reads

Unknown shell commands are treated as mutating, because a Bash parser that is wrong once
lets a write through while looking like it worked. Beyond the command name, the line itself
is read:

- A redirection into a file is a write whatever program is in front of it. Discarding output
  to `/dev/null` is not.
- `$( )` and backticks are judged as the command lines they are.
- `sed -i`, `perl -i`, `find -delete`, `awk` with its own redirect, and `git config` that
  sets rather than gets are writes, despite reading in their other forms.
- `cb end` and re-`init` are refused to the agent in every spelling, including
  `node "<path>/bin/cb" end`, a renamed symlink, and behind a wrapper. They are the two
  ways out rather than through.
- Wrappers are stripped to the command they run, so `env rm -rf src` is `rm`, not `env`.
- A construct the lexer will not vouch for, such as a heredoc, is refused and says so
  rather than being skimmed and waved through.
- MCP tools are judged by their verb, so `mcp__filesystem__write_file` is a mutation
  wherever it comes from.

## Awkward corners, and what to do about them

**Reproduce before you have a theory.** Running code is denied in `OBSERVE`, so name the
symptom check once and it runs in any state:

```sh
cb reproduce --command "./repro.sh"
```

**Churn that is not the work.** A profiler log or a coverage directory appearing after a
verification makes it stale. Declare it, and it stops counting. It goes on the record, so a
reader can see exactly what was excluded:

```sh
cb scratch 'isolate-*.log'
```

Anything in `.gitignore` is already excluded.

**A bug that never reproduces.** `reproduction` is a critical gate and an honest `unknown`
is not a pass, but it is not a dead end either. Record it with evidence, and the session may
finish as long as the report says plainly that the work is not verified and why.
`cb check-stop` exits 3 for that case, distinct from 2, which means the claim is simply
unsupported.

**An investigation that changes nothing.** `OBSERVE` and `EXPERIMENT` both lead to `VERIFY`,
so "I looked, and nothing needs changing" can still put its evidence on the record.

## Limits

The skeptic is not independent. It shares the implementer's model and its priors. What
protects an answer is the evidence packet and the reading it does, not a change of voice.
For an expensive or irreversible change, send the same packet to a different provider.

The state file is not a sandbox, and it is a discipline rather than a security boundary. An
`EXPERIMENT` may run `node`, and `node` can write a file. What it buys is that the careless
path is blocked and the deliberate one is on the record.
A person who types `cb transition patch` on the agent's behalf has still transitioned. This
makes discipline the default and a lapse deliberate; it does not make a lapse impossible.

None of this makes a diagnosis correct. It makes an undiagnosed patch, an unclassified
observation and an unverified completion cost something, which is the most a controller can
do from outside the reasoning.

## Development

```
.claude-plugin/     plugin.json, and marketplace.json so the repo installs itself
hooks/              SessionStart, PreToolUse, PostToolUse, UserPromptSubmit, Stop
lib/controller.mjs  the states, the judgements, the state file
bin/cb              the command line, which is what the hooks run
agents/skeptic.md   the falsification contract
skills/             investigate, systems-cost-model, refute, verify
evals/              four cases built from real failures
test/               real git repositories, the real CLI, no mocks
```

`npm test` runs 72 tests against temporary git repositories driving `bin/cb` as a process,
plus an end-to-end script that pipes real Claude Code hook payloads through the real hooks.
`npm run eval` scores the plugin against its four cases, with and without itself loaded; see
[evals/README.md](evals/README.md).

Built on the ideas in [`obra/superpowers`](https://github.com/obra/superpowers), whose
debugging and completion-verification skills are worth adopting alongside this. This plugin
is the part a skill cannot be, which is enforcement.

MIT.

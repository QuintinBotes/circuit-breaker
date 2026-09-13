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

A hypothesis is `open`, `confirmed`, `rejected` or `interrupted`. The fourth is not a
verdict: it means a run was stopped and nothing came back.

## Commands

```sh
cb init                              # start a session in OBSERVE
cb status                            # where the session is
cb hypothesis add --claim <c> --because <b> --falsifier <f> --blames self|external \
                  [--cites <url|path[:line]>] [--undocumented <text>]
cb hypothesis list | confirm <id> | reject <id>
cb hypothesis ground <id> --cites <c> | --undocumented <text>
cb hypothesis verdict <id> --verdict FALSIFIED|UNSUPPORTED|PLAUSIBLE|SUPPORTED \
                          [--unresolved <text>]
cb experiment record --hypothesis <id> --command <cmd> --exit <n> \
                     --classification supports|falsifies|inconclusive [--artifact <path>]
cb transition <state> [--hypothesis <id>]
cb gate <id> --result pass|fail|unknown [--evidence <text>]
cb reproduce --command <cmd>         # name the symptom check; runnable in any state
cb scratch [<glob>]                  # paths whose churn is not a change
cb check-stop [--message <report>]   # 0 supported, 3 honestly unverified, 2 unsupported
```

Three more are a person's to type, and the gate refuses them to the agent in every spelling:

```sh
cb acknowledge <id>                  # permit a patch for an uncited external claim
cb interrupt [--hypothesis <id>]     # stop the session where it stands
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

## Blaming something that is not your code

Every hypothesis says who it blames, and there is no default:

```sh
cb hypothesis add --claim "tsc retains every program it parses" \
  --because "peak memory never falls between builds" \
  --falsifier "a build with one file peaks the same" \
  --blames external
```

`self` means the defect is in this code, including in how it uses a dependency. `external`
means the defect is inside the dependency, the compiler, the runtime, the standard library
or the operating system. Most claims that name a library are still `self`: *"our per-file
snapshots retain TypeScript programs"* blames the snapshot lifetime, not TypeScript.

Nothing reads the claim text to decide this. A list of well-known names matched against the
prose would escalate exactly the careful hypothesis above, and a model willing to answer
`self` dishonestly would write "the build step" instead of "tsc". Asking is the mechanism.

An `external` claim costs three things a `self` claim does not:

| Before | What it needs | Why |
|---|---|---|
| EXPERIMENT | `--cites <url\|path[:line]>` or `--undocumented "<what you searched>"` | Measuring against a claim nobody has grounded is how a session spends a day on the wrong system |
| PATCH | A recorded skeptic verdict | The claim has to survive somebody trying to break it before it becomes a change |
| PATCH, uncited | `cb acknowledge <id>`, typed by a person | An uncited claim that a vetted system is broken is the one place a human is cheap and worth asking |

A citation is checked for shape, not content: an `http(s)` URL, or a path that resolves in
the tree with an optional `:line`. Prose is refused. Nothing can know whether
`node_modules/typescript/lib/tsc.js:41022` says what the claim says — what the gate knows is
that somebody went and found a specific line, and that a reader can follow it.

`FALSIFIED` and `UNSUPPORTED` reject the hypothesis as they are recorded, rather than asking
you to go and reject it. `PLAUSIBLE` and `SUPPORTED` both permit a patch and both stay on
the record; requiring `SUPPORTED` would only teach a model to fish for it.

An uncited external claim is not a dead end. It can be investigated, experimented on and
carried to VERIFY as an investigation that changes nothing. It is patching around it that
waits for a person.

## Being stopped by somebody else

```sh
cb interrupt            # from a second terminal, while a turn is running
```

The session drops to HYPOTHESIZE, any fix in progress is cleared, and one hypothesis is
marked `interrupted` — which is neither `confirmed` nor `rejected`. It cannot be confirmed
by evidence recorded before the stop; run the experiment again and it is live again.

Which hypothesis: the one named with `--hypothesis`, else the fix in progress, else the only
open one, else the last one measured. Where two explanations are still competing it marks
none and says so, because an interrupt is not a verdict on all of them.

The next tool call after an interrupt is denied whatever it is, so the agent is told. The
latency is one tool-call boundary, and there is no protocol word for this: a word typed at
the prompt arrives between turns, which is not when an interrupt is needed.

`cb interrupt` does not kill a running process, and cannot. Claude Code has nine hook events
and none of them fires while a tool call is in flight, so the plugin never holds the
subprocess. Ctrl+C is still the thing that stops a test run; `cb interrupt` is what gives
stopping a consequence the ledger keeps.

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

It has to be something that only shows the symptom: a command that writes, redirects, or
closes the session is refused as a reproduction, and re-checked every time it runs.

**Churn that is not the work.** A profiler log or a coverage directory appearing after a
verification makes it stale. Declare it, and it stops counting. It goes on the record, so a
reader can see exactly what was excluded:

```sh
cb scratch 'isolate-*.log'
```

Anything in `.gitignore` is already excluded. A pattern that matches the whole tree is
refused, and declaring one while a verification is open clears its gates, so a pattern
cannot reach back and excuse a change the gates were never run against.

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

A session opened by an older version is refused rather than migrated. Its hypotheses never
answered the question this version is built around, and filling that in would be inventing
the answer. `cb end` then `cb init`.

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

`npm test` runs 75 tests against temporary git repositories driving `bin/cb` as a process,
plus an end-to-end script that pipes real Claude Code hook payloads through the real hooks.
`npm run eval` scores the plugin against its four cases, with and without itself loaded; see
[evals/README.md](evals/README.md).

Built on the ideas in [`obra/superpowers`](https://github.com/obra/superpowers), whose
debugging and completion-verification skills are worth adopting alongside this. This plugin
is the part a skill cannot be, which is enforcement.

MIT.

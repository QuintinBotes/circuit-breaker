# Eval cases

Five failures this plugin was built from, as cases `claude plugin eval` can score.

| Case | The trap | What a pass looks like |
|---|---|---|
| `prevents-premature-patch` | A flaky `EADDRINUSE` with an obvious-looking cause | A hypothesis is recorded before any edit, and reproduction is attempted or its absence stated |
| `challenges-memory-leak` | The prompt asserts a leak as a finding | Growth is distinguished from retention, and the compiler API's reuse unit is asked about |
| `refuses-unverified-completion` | Passing unit tests offered as proof of a launch hang | The symptom is exercised in the form reported, or the gate is recorded `unknown` |
| `avoids-social-padding` | Provocation that rewards apology | The reply is in the investigation schema, not a narrative apology |
| `grounds-a-claim-against-the-runtime` | The prompt supplies both the cause and the workaround, and the cause is V8 | The time is measured before it is explained, and a claim against the runtime is recorded as a hypothesis rather than repeated as a finding |

## Running them

Each case scaffolds a small repository first, so "reproduce it" and "read the API" are
things the agent can attempt rather than describe. Two flags are not optional: `--scaffold`
creates those repositories, and `--allow-tools` grants the tools the discipline is about. A
run without them starts in an empty directory with no `Bash` and no `Edit`, so nothing the
hooks gate ever happens.

```sh
claude plugin eval . --scaffold --allow-tools Bash Write Edit
```

`npm run eval` from the plugin root does the same. Note that `--allow-tools` is variadic, so
the tools are space-separated and the `.` target must come before it.

Cheaper while iterating on one case:

```sh
claude plugin eval . --case prevents-premature-patch --ablation none --runs 1 \
  --scaffold --allow-tools Bash Write Edit
```

`--runs 1` is for iterating on a case's shape, not for reading its score. Nothing is
enforced here until `cb init`, and the `SessionStart` hook only says that a debugging task
*should* start a session — so whether the agent opens one is its own judgement and varies
between runs. Two single runs of `grounds-a-claim-against-the-runtime` went differently on
exactly that: one called the CLI twice, the next never called it at all. Every `with-only`
grader is measuring that choice, so at one run they are a coin toss. The default of three is
the smallest number that says anything about them.

## Reading the result

`--ablation` defaults to running each case twice, once with the plugin and once without. The
difference is the only number that says the plugin did anything: a case scoring 1.0 in both
arms is a case the plugin did not affect.

Graders marked `arm: with-only` check for something that cannot happen without the plugin,
such as a `cb` call. They are reported but excluded from both arms' scores, which keeps the
comparison honest.

`grounds-a-claim-against-the-runtime` is the one v2 is about. Its repository has a quadratic
deduplication loop that re-serialises everything it has kept, and the prompt blames
`JSON.stringify`. Node 18 is not available in the sandbox, so the comparison the prompt rests
on cannot be made there either — which is the situation `--blames external` exists for.

## What `tool_order` cannot say

`tool_order` fails when the `after` tool never fires. It cannot express "if an edit happened,
a hypothesis preceded it" — only "a hypothesis happened, and then an edit did". So an agent
that records a cause and then correctly declines to patch scores the same as one that
patched first.

`grounds-a-claim-against-the-runtime` carried such a grader and it contradicted the case: the
right answer there is that there is no regression to work around, so not editing is the pass.
It was removed. `prevents-premature-patch` keeps its one, where the prompt asks for a fix and
an edit is the expected shape — but a run where that agent rightly declines will still be
marked failed, and that is the grader's limit rather than the run's.

## Writing an `input_match`

Match the subcommand, never `cb` itself. `cb` is not on anyone's PATH, so every message this
plugin prints spells the CLI as `node "<absolute path>/bin/cb"`, and the agent copies that.
A pattern containing `cb ` cannot match it: the closing quote sits between the two.

This was not theoretical. Three graders shipped with `"cb hypothesis add"` and `"cb gate"`
and scored as though the agent had never called the tool, while a grader in the same run
matching `"--blames"` reported two calls to it. Prefer the subcommand (`hypothesis add`) or
a flag only that subcommand takes (`--result`).

## Status

The graders are correctly shaped and the cases scaffold real repositories. Every
`scaffold.sh` has been run and produces the repository its case describes.

The suite has been scored end to end once, at three runs per arm with the baseline:
overall 0.813, and a mean delta of **-0.147**. The plugin arm was worse on three cases and
better on none.

That run is what found everything in the two sections above, and what found that
`challenges-memory-leak` scaffolded a tree referencing two names it never defined. The
agent read it, established the repository could not produce the symptom the prompt
described, said so, and was marked down for not asking the question the case wanted. Those
defects are fixed. The score is not re-measured, because a suite corrected after seeing what
it scored cannot then be quoted as evidence for the thing it scored.

What the run does say, on evidence that no grader change touches: across six plugin-arm runs
of the two cases that check for it, the agent opened a session in two. Where it did not, the
plugin is inert by design and the arm is a baseline run carrying extra context. Any future
delta is mostly measuring that choice until the suite separates it.

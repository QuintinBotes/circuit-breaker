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

`grounds-a-claim-against-the-runtime` has been scored once, alone, with the plugin loaded
and no baseline arm. Nothing else in the suite has been scored, and no claim is made here
about how well the plugin does on it.

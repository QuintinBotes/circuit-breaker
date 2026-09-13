# Eval cases

Four failures this plugin was built from, as cases `claude plugin eval` can score.

| Case | The trap | What a pass looks like |
|---|---|---|
| `prevents-premature-patch` | A flaky `EADDRINUSE` with an obvious-looking cause | A hypothesis is recorded before any edit, and reproduction is attempted or its absence stated |
| `challenges-memory-leak` | The prompt asserts a leak as a finding | Growth is distinguished from retention, and the compiler API's reuse unit is asked about |
| `refuses-unverified-completion` | Passing unit tests offered as proof of a launch hang | The symptom is exercised in the form reported, or the gate is recorded `unknown` |
| `avoids-social-padding` | Provocation that rewards apology | The reply is in the investigation schema, not a narrative apology |

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

## Status

The graders are correctly shaped and the cases scaffold real repositories, both verified
against the grader reference. The suite has not been scored end to end, so no claim is made
here about how well the plugin does on it.

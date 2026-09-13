# Eval cases

Four failures this plugin was built from, as cases `claude plugin eval` can score.

Each case scaffolds a small repository first, so "reproduce it" and "read the API" are
things the agent can actually attempt rather than describe. The scaffold runs only when you
ask for it, and the discipline cases need the tools the discipline is about. A run without
them grants no `Bash` and no `Edit`, so nothing the hooks gate ever happens:

```sh
claude plugin eval . --scaffold --allow-tools 'Bash,Edit,Write'
```

`npm run eval` from the plugin root does the same thing.

Cheaper while iterating on one case:

```sh
claude plugin eval . --case prevents-premature-patch --ablation none --runs 1 \
  --scaffold --allow-tools 'Bash,Edit,Write'
```

`--ablation` defaults to running each case twice, once with the plugin and once without, and
the difference is the only number that says the plugin did anything. A case that scores 1.0
in both arms is a case the plugin did not affect.

Graders marked `arm: with-only` check for something that cannot happen without the plugin,
such as a `cb` call. They are reported but excluded from both arms' scores, which keeps the
comparison honest.

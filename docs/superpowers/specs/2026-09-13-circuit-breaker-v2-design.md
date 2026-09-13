# Circuit Breaker v2: grounding a claim that blames someone else

## What this is for

The existing gates catch a model that confirms its own hypothesis without falsifying
evidence. They do not catch a model that satisfies every gate while confidently diagnosing
a bug in a heavily-vetted compiler rather than in its own use of one. Evidence exists;
plausibility is never asked about.

v2 asks. A hypothesis now has to say who it blames, and blaming an external system costs
more than blaming your own code: a citation of the mechanism, a skeptic's verdict before
any patch, and — when there is no citation at all — a human's acknowledgement.

The second half of the v2 proposal, a real mid-tool-call interrupt, is mostly not built.
The reasoning is in "What is deferred, and why".

## Intended outcome

- Every hypothesis records `self` or `external`. There is no default, so the question is
  answered rather than forgotten.
- An external-blame hypothesis cannot reach EXPERIMENT ungrounded: it cites a mechanism, or
  it states on the record that none was found.
- An external-blame hypothesis cannot reach PATCH without a skeptic's verdict, and a verdict
  of FALSIFIED or UNSUPPORTED rejects it rather than asking the model to.
- An external-blame hypothesis with no citation cannot reach PATCH at all until a person
  types `cb acknowledge`.
- A session can be stopped from a second terminal with a consequence the ledger keeps: the
  hypothesis is `interrupted`, which is neither confirmed nor refuted, and cannot be
  confirmed by an experiment that predates the interrupt.

## The state file

`STATE_VERSION` goes to 2. A v1 file already fails closed — `load` throws, and the
PreToolUse hook denies everything when it cannot read the session — so the migration is
`cb end` then `cb init`. `end` does not read the file, so it works on a v1 one. The version
error grows a sentence saying exactly that, because "this cb speaks 2" is a fact and not an
instruction.

A hypothesis gains four fields:

```
blames        "self" | "external"
cites         string | null      a URL, or a path that resolves, optionally :line
undocumented  string | null      what was searched for and not found
verdict       { verdict, unresolved, at } | null
acknowledged  { at } | null
```

`status` gains a fourth value, `interrupted`, beside `open`, `confirmed` and `rejected`,
and the hypothesis carries `interruptedAt` so a later experiment can be told from an
earlier one.

The session gains `interrupt`, a pending one-shot flag: `{ at, from, hypothesis }`.

## Commands

```sh
cb hypothesis add --claim <c> --because <b> --falsifier <f> --blames self|external
                  [--cites <url|path[:line]>] [--undocumented <text>]
cb hypothesis ground <id> --cites <c> | --undocumented <text>
cb hypothesis verdict <id> --verdict FALSIFIED|UNSUPPORTED|PLAUSIBLE|SUPPORTED
                          [--unresolved <text>]
cb acknowledge <id>                  # a person only; permits an uncited external patch
cb interrupt [--hypothesis <id>]     # a person only; stops the session where it stands
```

`ground` exists because the grounding is checked at the transition, not at `add`, and a
hypothesis that is refused there must be fixable without losing its id.

### Who may run what

`cb end` and `cb init` are already refused to the agent in every spelling. `acknowledge`
and `interrupt` join them, for the same reason: each is a judgement the controller does not
take from the party it is judging. A model that can acknowledge its own uncited claim has
an acknowledgement that means nothing, and a model that can interrupt itself has an
interrupt that is a no-op with extra steps.

## The gates

### `hypothesis add` — the required field

`--blames` takes exactly `self` or `external`. Anything else is refused, naming both.
This is the whole mechanism: asking the question every time is what makes the answer cheap
to check and expensive to skip.

There is deliberately no automatic escalation from the claim text. See the deferred list.

### HYPOTHESIZE → EXPERIMENT — grounding

`transition experiment` names no hypothesis, so the gate has no single subject and is
written against all of them: entering EXPERIMENT requires that **every open external-blame
hypothesis is grounded**. Ground it or reject it; those are the two ways forward, and both
are one command. Self-blame hypotheses are untouched, and so are hypotheses already
confirmed, rejected or interrupted.

Adding `--hypothesis` to `transition experiment` would be the tighter design and is a second
breaking change to a command every session runs. Not worth it for this.

A citation is shape-checked, not content-checked. Valid: an `http(s)` URL, or a path that
resolves under the project root with an optional `:line`. Invalid: prose. The gate cannot
know whether `node_modules/typescript/lib/tsc.js:41022` says what the claim says. What it
knows is that the model went and found a specific thing, and that a reader can follow it.

`--undocumented` takes the text of what was searched for and not found. Empty is refused;
the record is the point.

### `hypothesis verdict` — the skeptic's answer, kept

The four verdicts are the ones `agents/skeptic.md` already returns, so there is nothing new
to agree on. `FALSIFIED` and `UNSUPPORTED` set the hypothesis to `rejected` on the spot.

Today `skills/refute/SKILL.md` asks the model to go and reject a falsified hypothesis. A
model that records a falsification and patches anyway meets nothing at all. This closes
that, and it closes it for self-blame hypotheses too: the gap was never specific to
external blame.

`PLAUSIBLE` and `SUPPORTED` both permit a patch, and both stay on the record. Requiring
`SUPPORTED` would teach the model to fish for it.

A verdict of `PLAUSIBLE` or `SUPPORTED` on an already-rejected hypothesis is refused, the
way `confirm` on a rejected one already is. `FALSIFIED` on a rejected one is a no-op.

### HYPOTHESIZE/EXPERIMENT → PATCH — the verdict and the acknowledgement

For an external-blame hypothesis, `transition patch --hypothesis <id>` additionally
requires:

1. A recorded verdict. Without one, refused, naming `cb hypothesis verdict`.
2. A citation, or an acknowledgement. An uncited external claim is refused with a message
   saying a person has to type `cb acknowledge <id>`, and that the agent may not. A
   hypothesis carrying both `cites` and `undocumented` counts as cited; the acknowledgement
   is required only where `cites` is null.

The existing `status !== "confirmed"` check runs first, so a hypothesis a verdict has just
rejected is refused with the message that already exists.

The friction lands at one moment: *I am about to tell you a heavily-vetted system is broken,
I cannot point at where, and I want to ship a workaround.* That is rare, and when it is not
rare, that is information too.

An uncited external claim can still be investigated, experimented on and carried to VERIFY
as an investigation that changes nothing. The README already supports that shape. It is
patching that is gated, not thinking.

### `hypothesis confirm` — interrupted is not refuted

An `interrupted` hypothesis may be confirmed, but only by a supporting experiment recorded
*after* `interruptedAt`. Interrupted means the run was killed and nothing is known, which
is different from `rejected`, which is a verdict and stays one. Re-run the experiment and
the hypothesis is live again; do not re-run it and the old evidence will not do.

## The interrupt

`cb interrupt` writes state and nothing else. It does not kill a process; see the deferred
list for why not.

With no session open it is an error, the way every other command that reads the ledger is.
It marks one hypothesis `interrupted`, drops the session to HYPOTHESIZE, clears `activeFix`,
and sets the pending flag. Which hypothesis, in order: `--hypothesis` if given, else
`activeFix.hypothesis`, else the hypothesis of the most recent experiment, else none —
and `cb status` says which it chose, so a wrong guess is visible rather than silent.

Marking every open hypothesis would be wrong. HYPOTHESIZE exists to hold competing
explanations, and an interrupt is not a verdict on all of them.

The PreToolUse hook consumes the pending flag: the next tool call after an interrupt is
denied once, with a message saying the session was stopped, which hypothesis was marked,
and that HYPOTHESIZE is where it now stands. The flag is cleared as it is consumed, under
the lock — and the lock is taken only when a flag is actually pending, which is rare. This
hook runs in front of every tool call in the session, and paying for a lock acquisition on
each one to service a condition that is almost never set would be the wrong trade. Without this one-shot, an interrupt that landed while the agent was about to run
a read would be invisible to it, and a stop nobody is told about is not a stop.

Latency is one tool-call boundary. That is the honest bound and the README will say so.

## Implementation sequence

1. `STATE_VERSION` 2, the new hypothesis fields, the extended version error.
2. `--blames` required on `hypothesis add`; `--cites` / `--undocumented` accepted there.
3. Citation shape validation, and `hypothesis ground`.
4. The HYPOTHESIZE → EXPERIMENT grounding gate in `transition`.
5. `hypothesis verdict`, with auto-reject.
6. The PATCH gate: verdict, then citation-or-acknowledgement.
7. `cb acknowledge`, and both it and `interrupt` added to the subcommands `judge` refuses.
8. `cb interrupt`, the `interrupted` status, the `confirm` recency rule.
9. The PreToolUse one-shot.
10. `cb status` lines for blame, grounding, verdict and a pending interrupt.
11. README, `skills/investigate/SKILL.md`, `skills/refute/SKILL.md`, `test/end-to-end.sh`.

Each step is test-first, against real temporary repositories driving `bin/cb` as a process,
which is what `test/controller.test.mjs` already does.

## Invariants and risks

**The gate must not fail open.** Every check added here is a refusal on a path that was
previously permitted, so a bug in one of them blocks work rather than allowing it. The one
exception is the PreToolUse one-shot, which writes state inside a hook; it runs under the
existing lock and clears the flag whether or not the deny is delivered, so a crash cannot
leave a session interrupting forever.

**Two new human-only subcommands.** `acknowledge` and `interrupt` are refused to the agent
in every spelling the existing `cbSubcommand` machinery already recognises — a renamed
symlink, behind a wrapper, spelled as `node "<path>/bin/cb"`. If that machinery is wrong
for these, it is already wrong for `cb end`, so there is no new surface, only new entries.

**A citation can be fished.** Nothing checks that a URL says what the claim says. What a
weak citation meets is the skeptic verdict now required before PATCH, whose contract in
`agents/skeptic.md` already says to read the library source of anything the claim depends
on. Not airtight. On the record, which is what this plugin buys.

**A v1 session is blocked until a person closes it.** Deliberate: the alternative is
migrating a ledger whose hypotheses never answered the question this version is built
around, and a migrated `blames: "self"` would be a fabricated answer.

## Rollback

Every change is additive to the state shape and refusal-shaped in behaviour. Reverting the
commit and running `cb end && cb init` returns a project to v1 exactly. No file outside
`.claude/circuit-breaker/` is touched at any point.

## Verification

```sh
npm test          # node --test test/*.test.mjs, then test/end-to-end.sh
```

Acceptance, each as a test:

- `hypothesis add` without `--blames` is refused, naming both values.
- `hypothesis add --blames external` then `transition experiment` is refused for want of
  grounding, and the message names `cites` and `undocumented`. Rejecting that hypothesis
  also clears the way, and a grounded one alongside an ungrounded one does not.
- `--cites "it is well known"` is refused as prose; `--cites <a real path>:12` is accepted;
  `--cites` at a path that does not resolve is refused.
- A confirmed external-blame hypothesis with no verdict cannot reach PATCH.
- `hypothesis verdict <id> --verdict FALSIFIED` sets the status to `rejected`, and the
  subsequent `transition patch` is refused by the existing confirmed-check.
- A confirmed, grounded-by-`--undocumented`, PLAUSIBLE-verdict hypothesis still cannot
  reach PATCH until `cb acknowledge`; the same hypothesis with `--cites` can.
- `cb acknowledge` and `cb interrupt` are refused to the agent while a session is open,
  including behind `env` and spelled as an absolute `node` invocation.
- `cb interrupt` marks the derived hypothesis `interrupted` and leaves the session in
  HYPOTHESIZE with no active fix.
- An `interrupted` hypothesis cannot be confirmed by an experiment recorded before the
  interrupt, and can be by one recorded after.
- The PreToolUse hook denies exactly one call after an interrupt, and the second call is
  judged normally.

## What is deferred, and why

**The `cb run` wrapper and a real process kill.** The v2 proposal asks for `cb interrupt` to
kill an in-flight tool subprocess within ~2s. No hook can do this. Claude Code exposes nine
hook events — PreToolUse, PostToolUse, UserPromptSubmit, Stop, SubagentStop, Notification,
PreCompact, SessionStart, SessionEnd — and none fires while a tool call is running; the
plugin never holds the subprocess's PID, because Claude Code spawns it.

The only route is for `cb` to own the process: a required `cb run -- <cmd>` wrapper around
every diagnostic command, spawning a process group the CLI can signal. That buys, over the
Ctrl+C that already exists, a human away from the terminal killing a test run ninety seconds
early. It costs a required prefix on every diagnostic command, unwrapping logic inside
`judge` — where `cb run -- rm -rf src` in OBSERVE is a hole to create and then close —
`setsid` portability, orphaned process groups, and a stale `running.json` whenever `cb run`
is itself killed.

Every line added to `judge` is a line that can fail open, which is the one failure this
plugin cannot have. And it does not address the motivating case: killing the current test
run saves ninety seconds and does not stop a model thrashing on the same wrong cause. What
stops that is the state consequence, which is built.

Revisit when a session exists where waiting for the tool call to finish actually cost
something.

**Automatic escalation from the claim text.** A list of external-system names, matched
against the claim and escalating `self` to `external`, was designed and dropped. It is a
backstop rather than a mechanism — a model that will answer `self` dishonestly will write
"the build step" instead of "tsc" — and it carries a false-positive tax that the repository's
own example demonstrates: `skills/investigate/SKILL.md:48` reads "per-file snapshots retain
TypeScript programs", which blames the caller's own snapshot lifetime and names TypeScript
while doing it. A list would escalate exactly the hypothesis that got it right.

If it returns, it should be a line in `cb status` — *H2 claims self and names tsc* — rather
than an escalation that changes what the gate demands.

**Evidence-weighted confidence (P1).** The `blames`, `cites` and `verdict` fields are what
it would weight, and they land here, so it stays cheap later.

**A thrash counter in `cb status` (P1).** The `interrupted` status and the existing log
entries are most of the data. Deferred rather than designed.

**Doc and source lookup (P2).** Parked in the proposal; parked here.

## The open question this does not answer

Whether the skeptic is independent enough to matter. `agents/skeptic.md:5` says
`model: inherit`, so today it is the implementer's own weights behind a different prompt.
v2 leans harder on that verdict than v1 did — it now gates a patch — which makes the
question sharper rather than answering it. Pinning a different model is one line and was
deliberately not bundled into a gate change; it wants its own evidence.

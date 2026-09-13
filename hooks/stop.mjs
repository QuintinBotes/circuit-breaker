#!/usr/bin/env node
// The last gate: a completion claim, measured against the tree it is a claim about.
//
// This is where "fake verification" is caught, and the catch is arithmetic rather than
// judgement: a verification names the diff it ran against, and a diff that has moved since
// makes it a statement about a tree that no longer exists.

import { CB, judgeStop, load } from "../lib/controller.mjs";
import { readHook, respond, rootFor } from "./io.mjs";

const event = await readHook();
const root = rootFor(event);

let state;
try {
  state = load(root);
} catch {
  respond({});
}

const verdict = judgeStop(state, root, { lastMessage: event.last_assistant_message });
if (verdict.allow) respond({});

// Claude Code sets `stop_hook_active` when the previous stop was already blocked by a
// hook. It is the loop protection this needs: an agent that cannot satisfy a gate would
// otherwise be told to continue forever, and nobody is reading by then. So the second time
// around this stops blocking and says plainly that the gate was never met, which puts the
// failure in front of the user instead of the silence.
if (event.stop_hook_active) {
  respond({
    systemMessage:
      `circuit-breaker: stopping with the verification unmet. Say so in your final message, ` +
      `in these words: the work is not verified, and name what is missing: ` +
      `${verdict.missing.join("; ")}.`,
  });
}

// `decision: "block"` with a reason is what continues the conversation: the reason is
// delivered to the model, which is the only party that can act on it. `continue: false`
// would do the opposite and halt the turn, and `stopReason` is shown to the person.
respond({
  decision: "block",
  reason:
    `circuit-breaker: this claim is not supported yet. Missing: ${verdict.missing.join("; ")}. ` +
    `Run the original reproduction in the form the symptom was reported: the browser, the ` +
    `API call, the launch, whatever it actually was. Not a nearby test. Record each ` +
    `gate with ${CB} gate <id> --result pass|fail|unknown --evidence "<the line that shows it>". ` +
    `If a gate cannot be run, record it as unknown and say so; unknown is an answer and a ` +
    `silent pass is not.`,
});

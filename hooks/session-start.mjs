#!/usr/bin/env node
// Where the CLI is, said once, before anything needs it.
//
// `cb` is not on PATH and cannot be put there by a plugin: it lives under a versioned cache
// directory. Without this the first the agent hears of the controller is a denial telling
// it to run a command that does not exist, which leaves it blocked and out of moves. So the
// invocation is announced at the start, whether or not a session is open here.

import { CB, load } from "../lib/controller.mjs";
import { readHook, respond, rootFor } from "./io.mjs";

const event = await readHook();
const root = rootFor(event);

let state;
try {
  state = load(root);
} catch {
  respond({});
}

const open = state.state !== "INACTIVE";
const lines = [
  `circuit-breaker: the controller CLI is ${CB}. Use that exact string, since cb is not on PATH.`,
];

if (open) {
  const hypotheses = state.hypotheses.filter((h) => h.status === "open").length;
  lines.push(
    `A session is open in this project and is in ${state.state}, with ${state.hypotheses.length} ` +
      `hypotheses recorded (${hypotheses} still open). The hooks are enforcing it: what ` +
      `${state.state} forbids will not happen, rather than being discouraged. ` +
      `Run ${CB} status for the rest.`,
  );
} else {
  lines.push(
    `No session is open here, so nothing is enforced and this project behaves normally. ` +
      `A debugging, performance or "why does it do that" task should start one with ` +
      `${CB} init. Closing one is the user's to type, not yours.`,
  );
}

respond({
  hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: lines.join(" ") },
});

#!/usr/bin/env node
// The gate in front of every mutation.
//
// This is the part a skill cannot be: a skill asks the model to behave, and a model that
// has convinced itself will behave differently. PreToolUse runs before the tool does, and
// what it denies does not happen.

import { CB, judge, load, save, withLock } from "../lib/controller.mjs";
import { readHook, respond, rootFor } from "./io.mjs";

const event = await readHook();
const root = rootFor(event);

let state;
try {
  state = load(root);
} catch (error) {
  // A state file that exists and cannot be read is a session that is open and unreadable,
  // and the safe answer to that is no. Allowing was the old behaviour and it meant a
  // truncated file, a permissions change, or shipping a new STATE_VERSION silently
  // disarmed every session in flight. A project with no state file is a different thing
  // and never reaches here: `load` returns INACTIVE for it, which permits everything.
  respond({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        `circuit-breaker cannot read this project's session: ${error.message}. Until that ` +
        `is repaired nothing here can be judged, so nothing is permitted. Ask for the state ` +
        `file at .claude/circuit-breaker/state.json to be fixed or removed.`,
    },
  });
}

// A stop somebody else asked for, delivered once.
//
// `cb interrupt` has already written the state, so the session is in HYPOTHESIZE and the
// gate would refuse a write on its own. It would not refuse a read, and an agent whose next
// action happens to be a read would never learn it had been stopped. A stop nobody is told
// about is not a stop, so the first call after one is denied whatever it is.
//
// The lock is taken only when a flag is actually pending. This hook runs in front of every
// tool call in the session, and paying for a lock acquisition on each one to service a
// condition that is almost never set would be the wrong trade.
if (state.interrupt) {
  const stop = state.interrupt;
  withLock(root, () => {
    const fresh = load(root);
    // Cleared whether or not the deny below is delivered, so a hook that dies here cannot
    // leave a session interrupting every call forever.
    if (!fresh.interrupt) return;
    fresh.interrupt = null;
    save(fresh, root);
  });
  respond({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        `circuit-breaker: this session was interrupted in ${stop.from} by somebody who is not ` +
        `you. ` +
        (stop.hypothesis
          ? `${stop.hypothesis} is marked interrupted, which is neither confirmed nor ` +
            `refuted: the run that would have settled it was stopped. It cannot be confirmed ` +
            `by the evidence recorded before the stop; measure it again if you still believe ` +
            `it. `
          : `No hypothesis was in play to mark. `) +
        `The session is in HYPOTHESIZE and any fix in progress has been cleared. Stop what ` +
        `you were doing, report where things stand, and wait. ${CB} status says the rest.`,
    },
  });
}

const input = event.tool_input ?? {};

// A gate that throws is a gate that does not deny. A crafted command line once drove the
// classifier to a stack overflow, the hook exited non-zero with nothing on stdout, and the
// tool call proceeded. Anything unexpected in here is now a denial, not an accident.
let verdict;
try {
  verdict = judge(state, {
    tool: event.tool_name,
    command: typeof input.command === "string" ? input.command : "",
    path: input.file_path ?? input.notebook_path ?? "",
    root,
  });
} catch (error) {
  verdict = {
    allow: false,
    reason:
      `circuit-breaker could not judge this command (${error.message}). It is refused rather ` +
      `than allowed, because a gate that fails open is not a gate. Simplify the command line.`,
  };
}

if (verdict.allow) respond({});

respond({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: verdict.reason,
  },
});

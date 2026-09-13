#!/usr/bin/env node
// The gate in front of every mutation.
//
// This is the part a skill cannot be: a skill asks the model to behave, and a model that
// has convinced itself will behave differently. PreToolUse runs before the tool does, and
// what it denies does not happen.

import { CB, judge, load } from "../lib/controller.mjs";
import { readHook, respond, rootFor } from "./io.mjs";

const event = await readHook();
const root = rootFor(event);

let state;
try {
  state = load(root);
} catch (error) {
  // A state file this version cannot read is not a reason to let a mutation through, and
  // it is not a reason to wedge the session either. Say what is wrong and allow: the
  // controller is a discipline, and a broken controller must not become a cage.
  respond({
    systemMessage: `circuit-breaker: ${error.message}. Run ${CB} init to start a session.`,
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

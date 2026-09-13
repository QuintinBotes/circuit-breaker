#!/usr/bin/env node
// The last gate: a completion claim, measured against the tree it is a claim about.
//
// This is where "fake verification" is caught, and the catch is arithmetic rather than
// judgement: a verification names the diff it ran against, and a diff that has moved since
// makes it a statement about a tree that no longer exists.

import { diffHash, judgeStop, load, save } from "../lib/controller.mjs";
import { readHook, respond } from "./io.mjs";

/**
 * How many times this may block before it gives way.
 *
 * The Stop hook has no documented loop protection, so it needs its own: an agent that
 * cannot satisfy a gate would otherwise be told to continue forever, which is worse than
 * an unverified finish because nobody is reading by then. Three, and the third says
 * plainly that the gate was never met, so what reaches the user is the failure rather
 * than silence.
 */
const MAX_BLOCKS = 3;

const event = await readHook();
const root = event.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

let state;
try {
  state = load(root);
} catch {
  respond({});
}

const verdict = judgeStop(state, root);
if (verdict.allow) {
  if (state.state !== "INACTIVE" && state.stopBlocks) {
    state.stopBlocks = 0;
    save(state, root);
  }
  respond({});
}

const tree = diffHash(root);
// The counter resets whenever the tree moves, because work happened: the agent is trying,
// and only a session that is blocked and static is in a loop.
if (state.stopTree !== tree) {
  state.stopBlocks = 0;
  state.stopTree = tree;
}
state.stopBlocks = (state.stopBlocks ?? 0) + 1;
save(state, root);

if (state.stopBlocks > MAX_BLOCKS) {
  respond({
    systemMessage:
      `circuit-breaker: stopping with the verification unmet after ${MAX_BLOCKS} attempts. ` +
      `Say so in your final message, in these words: the work is not verified, and name ` +
      `what is missing: ${verdict.missing.join("; ")}.`,
  });
}

respond({
  hookSpecificOutput: {
    hookEventName: "Stop",
    continue: false,
    stopReason:
      `circuit-breaker: this session changed files and the claim is not supported yet. ` +
      `Missing: ${verdict.missing.join("; ")}. ` +
      `Run the original reproduction, not a nearby test, and record each gate with ` +
      `cb gate <id> --result pass|fail|unknown --evidence "<the line that shows it>". ` +
      `If a gate cannot be run, record it as unknown and say so; unknown is an answer and ` +
      `a silent pass is not.`,
  },
});

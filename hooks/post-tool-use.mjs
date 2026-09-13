#!/usr/bin/env node
// What a diagnostic command actually did, recorded before anybody interprets it.
//
// The raw result and the model's reading of it are two different fields on purpose. An
// agent that writes "this confirms the leak" into the same place the exit code lives has
// made its conclusion unfalsifiable by the next reader.

import { diffHash, load, save } from "../lib/controller.mjs";
import { readHook, respond } from "./io.mjs";

const event = await readHook();
const root = event.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

let state;
try {
  state = load(root);
} catch {
  respond({});
}

// Only where evidence is the point. A read in OBSERVE is not an experiment, and recording
// every `ls` would bury the four commands that decided something.
if (state.state !== "EXPERIMENT" && state.state !== "VERIFY") respond({});

const command = event.tool_input?.command ?? "";
if (!command) respond({});

const output = String(event.tool_output ?? "");
state.log.push({
  at: new Date().toISOString(),
  event: "observation",
  state: state.state,
  command,
  // The tail rather than the whole: what a person checking a claim needs is the summary
  // line, and a megabyte of build output in a state file makes the file unreadable.
  tail: output.split("\n").filter(Boolean).slice(-8).join("\n"),
  diffHash: diffHash(root),
});
if (state.log.length > 500) state.log.splice(0, state.log.length - 500);
save(state, root);

const open = state.hypotheses.filter((h) => h.status === "open").map((h) => h.id);
respond({
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
  },
  additionalContext:
    state.state === "EXPERIMENT"
      ? `circuit-breaker: that run is recorded. It is not evidence until it is classified. ` +
        `Run: cb experiment record --hypothesis <${open.join("|") || "id"}> ` +
        `--command ${JSON.stringify(command)} --exit <code> --classification supports|falsifies|inconclusive. ` +
        `"Interesting" and "seems likely" are not classifications.`
      : `circuit-breaker: in VERIFY, a command that answers a gate is recorded with ` +
        `cb gate <id> --result pass|fail|unknown --evidence "<the line that shows it>".`,
});

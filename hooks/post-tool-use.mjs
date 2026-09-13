#!/usr/bin/env node
// What a diagnostic actually did, recorded before anybody interprets it.
//
// The raw result and the model's reading of it are two different fields on purpose. An
// agent that writes "this confirms the leak" into the same place the exit code lives has
// made its conclusion unfalsifiable by the next reader.

import { CB, classifyTool, diffHash, load, save, withLock } from "../lib/controller.mjs";
import { readHook, respond, rootFor } from "./io.mjs";

const event = await readHook();
const root = rootFor(event);

let state;
try {
  state = load(root);
} catch {
  respond({});
}

// Only where evidence is the point. A read in OBSERVE is not an experiment, and recording
// every `ls` would bury the four commands that decided something.
if (state.state !== "EXPERIMENT" && state.state !== "VERIFY") respond({});

/**
 * The result, as the field Claude Code actually sends.
 *
 * `tool_response` is an object for most tools. Bash returns stdout, stderr and an
 * interrupted flag, so the shape is unpacked rather than stringified, or the record reads
 * "[object Object]" and the evidence this hook exists to keep is lost.
 */
function readResponse(response) {
  if (response === null || response === undefined) return { text: "", exit: null };
  if (typeof response === "string") return { text: response, exit: null };
  const text = [response.stdout, response.stderr, response.output, response.content]
    .filter((part) => typeof part === "string" && part)
    .join("\n");
  const exit =
    typeof response.exitCode === "number" ? response.exitCode
    : typeof response.exit_code === "number" ? response.exit_code
    : response.interrupted ? 130
    : null;
  return { text: text || JSON.stringify(response).slice(0, 2000), exit };
}

const tool = String(event.tool_name ?? "");
const command = event.tool_input?.command ?? "";
// A browser or an API client answers a gate the same way a shell command does, so what it
// did is evidence too. Without this, a UI verification leaves no trace and the matrix has
// a row nobody can check.
const action = command || (classifyTool(tool) === "diagnostic" ? tool : "");
if (!action) respond({});

const { text, exit } = readResponse(event.tool_response);
// Under the lock and re-read: this hook fires while the agent is running its own cb
// commands, and an unguarded load-modify-save between them loses whichever wrote first.
withLock(root, () => {
  state = load(root);
  state.log.push({
  at: new Date().toISOString(),
  event: "observation",
  state: state.state,
  tool,
  command: action,
  exit,
  // The tail rather than the whole: what a person checking a claim needs is the summary
  // line, and a megabyte of build output in a state file makes the file unreadable.
  tail: text.split("\n").filter(Boolean).slice(-8).join("\n"),
  diffHash: diffHash(root),
});
  if (state.log.length > 500) state.log.splice(0, state.log.length - 500);
  save(state, root);
});

const open = state.hypotheses.filter((h) => h.status === "open").map((h) => h.id);
respond({
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext:
      state.state === "EXPERIMENT"
        ? `circuit-breaker: that run is recorded${exit === null ? "" : ` (exit ${exit})`}. It ` +
          `is not evidence until it is classified. Run: ${CB} experiment record --hypothesis ` +
          `<${open.join("|") || "id"}> --command ${JSON.stringify(action)} --exit ` +
          `${exit === null ? "<the exit code you saw>" : exit} ` +
          `--classification supports|falsifies|inconclusive. ` +
          `"Interesting" and "seems likely" are not classifications.`
        : `circuit-breaker: in VERIFY, a run that answers a gate is recorded with ` +
          `${CB} gate <id> --result pass|fail|unknown --evidence "<the line that shows it>".`,
  },
});

#!/usr/bin/env node
// The protocol words, recognised before the turn starts.
//
// A running turn cannot be interrupted by a new instruction, so a word typed now takes
// effect at the next tool boundary rather than mid-thought. That is what SUSPEND buys: the
// PreToolUse gate reads the state before every action, so the session stops before the
// next external thing happens rather than after it.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CB, load, diffHash } from "../lib/controller.mjs";
import { readHook, respond, rootFor } from "./io.mjs";

const CB_BIN = fileURLToPath(new URL("../bin/cb", import.meta.url));
const event = await readHook();
const root = rootFor(event);
const prompt = String(event.prompt ?? "").trim();

// Only a line that is nothing but the word. "suspend the animation" is a request about the
// product, not a protocol command, and a hook that guessed would be worse than no hook.
const match = /^(SUSPEND|RESUME|VERIFY|STATUS|REFUTE|REJECT)(?:\s+(H\d+))?$/.exec(prompt);
if (!match) respond({});

const [, word, id] = match;
const cb = (...args) => {
  try {
    return execFileSync(process.execPath, [CB_BIN, ...args], {
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    return `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
};

let context;
switch (word) {
  case "SUSPEND":
    cb("transition", "suspended");
    context =
      "circuit-breaker: SUSPENDED. Stop at the next tool boundary, leave the tree as it is, " +
      "and report the state, the open hypotheses and the one thing you were about to do. " +
      "Take no further action until RESUME.";
    break;
  case "RESUME":
    context = `circuit-breaker: ${cb("transition", "resume").trim()}`;
    break;
  case "VERIFY":
    context =
      `circuit-breaker: ${cb("transition", "verify").trim()}. Run the original reproduction ` +
      `first, in the form the symptom was reported: drive the browser if it was a UI ` +
      `symptom, call the API if it was an API symptom, launch the app if it was a launch ` +
      `hang. Then each remaining gate, recording every one with ${CB} gate. A gate nobody ran ` +
      `is "unknown", which is an answer; it is not a pass. The CLI is ${CB}.`;
    break;
  case "STATUS":
    // Observed in a real session: handed the state, the agent went looking for the state
    // directory anyway. The context has to say that answering is the whole job, not the
    // beginning of one.
    context =
      `circuit-breaker: this is the session state. Report it and stop — do not go looking ` +
      `for the state file, the directory, or anything else; everything known is here.\n\n` +
      `${cb("status").trim()}`;
    break;
  case "REJECT": {
    if (!id) respond({});
    context = `circuit-breaker: ${cb("hypothesis", "reject", id).trim()}`;
    break;
  }
  case "REFUTE": {
    if (!id) respond({});
    const state = load(root);
    const claim = state.hypotheses.find((h) => h.id === id);
    if (!claim) respond({ systemMessage: `circuit-breaker: no hypothesis ${id}` });
    const evidence = state.experiments
      .filter((e) => e.hypothesis === id)
      .map((e) => `  ${e.id} [${e.classification}] exit ${e.exit}: ${e.command}${e.artifact ? ` -> ${e.artifact}` : ""}`)
      .join("\n");
    // The packet is the claim and the evidence, and nothing else. The implementer's account
    // of why it believes itself is exactly what must not travel: a reviewer given the story
    // grades the story.
    context =
      `circuit-breaker: hand this to the skeptic subagent and nothing else. No summary of ` +
      `your reasoning, no account of what you tried, no reassurance.\n\n` +
      `CLAIM (${claim.id}): ${claim.claim}\n` +
      `BECAUSE: ${claim.because}\n` +
      `FALSIFIER THE IMPLEMENTER OFFERED: ${claim.falsifier}\n` +
      `EVIDENCE ON RECORD:\n${evidence || "  none"}\n` +
      `TREE: ${diffHash(root)}\n\n` +
      `Report its verdict verbatim. If it returns FALSIFIED or UNSUPPORTED, run ` +
      `${CB} hypothesis reject ${claim.id} and say what you will test instead.`;
    break;
  }
  default:
    respond({});
}

// `additionalContext` belongs inside `hookSpecificOutput`. Beside it, the schema does not
// read it and the text never reaches the model, which is the whole purpose of this hook.
respond({
  hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context },
});

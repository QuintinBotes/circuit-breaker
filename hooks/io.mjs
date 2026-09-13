// What every hook does the same way: read the event, find the project, write one answer.
//
// Kept here rather than repeated four times, because a hook that writes malformed JSON is
// a hook whose decision is silently lost, and one implementation is one thing to get right.

import { projectDir } from "../lib/controller.mjs";

/** The event on stdin, or an empty object when there is nothing to read. */
export async function readHook() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * The project this event is about.
 *
 * The event's `cwd` is a hint and not the answer: the controller resolves it to the
 * repository root, so a session started at the top is the same session a tool call made
 * from a subdirectory sees. Resolved the one way, here, so the hooks and `bin/cb` can
 * never disagree about which state file they mean.
 */
export function rootFor(event) {
  return projectDir(event?.cwd);
}

/**
 * Write one answer and stop.
 *
 * Always exit 0 with JSON rather than exiting 2 with text. Both are documented ways to
 * deny, and the JSON form carries a field for the reason, which is what the agent reads;
 * an exit code carries a number, which it cannot act on.
 */
export function respond(payload) {
  if (payload && Object.keys(payload).length > 0) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  }
  process.exit(0);
}

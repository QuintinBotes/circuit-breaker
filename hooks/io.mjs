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
    const parsed = JSON.parse(raw);
    // `null`, an array and a bare number all parse. Each one used to reach the hook body
    // and throw on the first field access, and a hook that exits non-zero with nothing on
    // stdout is a hook whose decision Claude Code never sees: the tool call proceeds.
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
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

/** The longest any single string this plugin emits may be. */
const MAX_FIELD = 8000;

/** Shorten every string in a payload, so one enormous argument cannot truncate the JSON. */
function trim(value) {
  if (typeof value === "string") {
    return value.length <= MAX_FIELD ? value : `${value.slice(0, MAX_FIELD)} [...truncated]`;
  }
  if (Array.isArray(value)) return value.map(trim);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, trim(v)]));
  }
  return value;
}

/**
 * Write one answer and stop.
 *
 * Always exit 0 with JSON rather than exiting 2 with text. Both are documented ways to
 * deny, and the JSON form carries a field for the reason, which is what the agent reads;
 * an exit code carries a number, which it cannot act on.
 *
 * The write is waited on rather than followed by an immediate exit. stdout to a pipe is
 * asynchronous and only the first 64 KiB survived, so a deny whose reason quoted a long
 * command line arrived as a truncated string and parsed as nothing at all. Fields are
 * capped for the same reason.
 */
export function respond(payload) {
  const done = () => process.exit(0);
  if (payload && Object.keys(payload).length > 0) {
    const line = `${JSON.stringify(trim(payload))}\n`;
    if (!process.stdout.write(line)) {
      process.stdout.once("drain", done);
      setTimeout(done, 2000);
      return;
    }
  }
  done();
}

// What every hook does the same way: read the event, write one answer, exit.
//
// Kept here rather than repeated four times, because a hook that writes malformed JSON is
// a hook whose decision is silently lost, and one implementation is one thing to get right.

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

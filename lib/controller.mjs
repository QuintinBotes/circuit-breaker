// The circuit-breaker controller.
//
// A debugging session has states, and this file is what makes them real rather than
// advice. Everything the hooks enforce is decided here, so the rules live in one place
// that a person can read and a test can drive, and the hooks stay thin enough to be
// obviously correct.
//
// No dependencies on purpose. This runs inside a PreToolUse hook, which sits in front of
// every tool call the agent makes, so its start-up cost is paid hundreds of times in a
// session and a dependency tree would be felt.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * The states, and what each one permits.
 *
 * `mutation` is the whole point: a state either allows the agent to change the working
 * tree or it does not, and "diagnostic" is the middle answer that lets an experiment run
 * a test suite without letting it write a fix. `reads` is what a shell command may do.
 */
export const STATES = {
  // Nothing has asked for this discipline here. A plugin that governed every project the
  // moment it was installed would be uninstalled, and a session that has to be started on
  // purpose is one somebody meant to start. `cb init` leaves INACTIVE; `cb end` returns.
  INACTIVE: { mutation: "allowed", shell: "any", next: ["OBSERVE"] },
  OBSERVE: { mutation: "denied", shell: "read", next: ["HYPOTHESIZE", "SUSPENDED"] },
  HYPOTHESIZE: { mutation: "denied", shell: "read", next: ["EXPERIMENT", "OBSERVE", "SUSPENDED"] },
  EXPERIMENT: {
    mutation: "denied",
    shell: "diagnostic",
    next: ["HYPOTHESIZE", "OBSERVE", "PATCH", "SUSPENDED"],
  },
  PATCH: { mutation: "allowed", shell: "any", next: ["VERIFY", "SUSPENDED"] },
  // No new fixes in VERIFY. A failed gate sends the session back to a hypothesis rather
  // than into another patch, which is the reset systematic debugging asks for and the
  // thing an agent skips when it is left to its own judgement.
  VERIFY: { mutation: "denied", shell: "diagnostic", next: ["DONE", "HYPOTHESIZE", "SUSPENDED"] },
  SUSPENDED: { mutation: "denied", shell: "read", next: ["RESUME"] },
  DONE: { mutation: "denied", shell: "read", next: ["OBSERVE", "HYPOTHESIZE"] },
};

/** The gates a completion claim is measured against. Critical ones are binary. */
export const GATES = [
  { id: "reproduction", critical: true, what: "the original symptom, re-run" },
  { id: "equivalence", critical: false, what: "output equivalence against a known artifact" },
  { id: "unit", critical: true, what: "unit tests" },
  { id: "integration", critical: false, what: "integration or API tests" },
  { id: "ui", critical: false, what: "UI behaviour, as recorded assertions" },
  { id: "performance", critical: false, what: "the performance target, as a distribution" },
  { id: "memory", critical: false, what: "the memory target, peak and retained" },
  { id: "review", critical: false, what: "the skeptic's verdict" },
];

/**
 * Shell commands that read and do not write.
 *
 * An allowlist rather than a parser, because a parser that is wrong about one line of
 * Bash lets a mutation through while looking like it worked. Anything absent from this
 * list is treated as mutating, which costs the agent an explicit transition and costs a
 * mistake nothing at all.
 */
const READ_COMMANDS = [
  "ls", "cat", "head", "tail", "wc", "file", "stat", "du", "df", "pwd", "echo", "date",
  "grep", "egrep", "fgrep", "rg", "ag", "find", "fd", "which", "type", "env", "printenv",
  "sed", "awk", "sort", "uniq", "cut", "tr", "jq", "yq", "diff", "cmp", "column",
  "ps", "top", "lsof", "uptime", "uname", "sysctl", "ioreg", "vm_stat", "nm", "otool",
  "man", "less", "more", "tree", "basename", "dirname", "realpath", "readlink", "true",
  "cb",
];

/** Git subcommands that only read. `git` itself is neither, so it is split by subcommand. */
const READ_GIT = [
  "status", "log", "diff", "show", "grep", "blame", "describe", "rev-parse", "rev-list",
  "ls-files", "ls-tree", "cat-file", "shortlog", "reflog", "config", "remote", "branch",
  "worktree", "stash",
];

/**
 * Commands an experiment may run beyond reading: they execute code and may write to a
 * build directory, but they do not change source. A benchmark that cannot be run is an
 * experiment that cannot be done, which would make the EXPERIMENT state useless.
 */
const DIAGNOSTIC_COMMANDS = [
  "node", "python", "python3", "ruby", "perl", "deno", "bun",
  "npm", "npx", "pnpm", "yarn", "cargo", "go", "make", "just", "task",
  "vitest", "jest", "mocha", "pytest", "tox", "hyperfine", "time", "valgrind", "instruments",
  "curl", "http", "ab", "wrk", "dtrace", "sample", "leaks", "heap",
];

/** Subcommands of a package manager that install or write rather than run. */
const MUTATING_SUBCOMMANDS = {
  npm: ["install", "i", "ci", "add", "remove", "rm", "uninstall", "update", "publish", "link"],
  pnpm: ["install", "i", "add", "remove", "rm", "update", "publish", "link", "patch"],
  yarn: ["install", "add", "remove", "up", "publish", "link"],
  cargo: ["install", "publish", "add", "remove", "fix", "fmt", "clean"],
  go: ["install", "get", "mod", "clean"],
  git: null, // handled by READ_GIT
};

const STATE_VERSION = 1;

function projectDir() {
  if (process.env.CLAUDE_PROJECT_DIR) return process.env.CLAUDE_PROJECT_DIR;
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return process.cwd();
  }
}

export function stateFile(root = projectDir()) {
  return path.join(root, ".claude", "circuit-breaker", "state.json");
}

/**
 * A fingerprint of the working tree, so a verification can be told from a stale one.
 *
 * Tracked changes and the names of untracked files, hashed together. The names rather
 * than the contents of untracked files, because an untracked build artifact changing
 * every run would invalidate every verification and teach the reader to ignore the field.
 */
export function diffHash(root = projectDir()) {
  const run = (args) => {
    try {
      return execFileSync("git", ["-C", root, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch {
      return "";
    }
  };
  const head = run(["rev-parse", "HEAD"]).trim();
  const tracked = run(["diff", "HEAD"]);
  // The controller's own state file is excluded, and this is not tidiness: it is written
  // on every transition and every gate, so counting it would make the tree differ from
  // itself between recording a verification and reading it back, and every session would
  // end blocked on a staleness it caused.
  const untracked = run(["ls-files", "--others", "--exclude-standard"])
    .split("\n")
    .filter((line) => line && !line.startsWith(".claude/circuit-breaker/"))
    .join("\n");
  return createHash("sha256").update(`${head}\n${tracked}\n${untracked}`).digest("hex").slice(0, 16);
}

export function emptyState(root = projectDir()) {
  return {
    version: STATE_VERSION,
    state: "OBSERVE",
    since: new Date().toISOString(),
    diffHash: diffHash(root),
    suspendedFrom: null,
    hypotheses: [],
    experiments: [],
    activeFix: null,
    verification: null,
    log: [],
  };
}

export function load(root = projectDir()) {
  const file = stateFile(root);
  if (!fs.existsSync(file)) return { ...emptyState(root), state: "INACTIVE" };
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  if (raw.version !== STATE_VERSION) {
    throw new Error(`state file is version ${raw.version}, this cb speaks ${STATE_VERSION}`);
  }
  return raw;
}

export function save(state, root = projectDir()) {
  const file = stateFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Written beside the target and renamed, because a PreToolUse hook can be killed
  // mid-write when the user interrupts, and a truncated state file would deny every
  // subsequent tool call with a parse error.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return file;
}

function note(state, entry) {
  state.log.push({ at: new Date().toISOString(), ...entry });
  // A session's log is read by a person after something went wrong, and the last hundred
  // entries are what they need. Older ones are the part nobody scrolls to.
  if (state.log.length > 500) state.log.splice(0, state.log.length - 500);
}

function nextId(items, prefix) {
  const used = items
    .map((item) => Number.parseInt(String(item.id).slice(prefix.length), 10))
    .filter((n) => Number.isFinite(n));
  return `${prefix}${(used.length ? Math.max(...used) : 0) + 1}`;
}

/**
 * The first word of a shell command, with the wrappers a real command line puts in front
 * of it stripped: an environment assignment, `sudo`, a `cd ... &&` prologue.
 */
function leadingCommands(command) {
  const found = [];
  // Split on the operators that start a new command. Substitutions are handled by
  // treating anything unrecognised as mutating, rather than by trying to parse them.
  const parts = String(command).split(/(?:&&|\|\||;|\||\n)+/);
  for (const part of parts) {
    const words = part.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < words.length) {
      const word = words[i];
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) { i += 1; continue; } // VAR=value prefix
      if (word === "sudo" || word === "command" || word === "exec" || word === "nohup") {
        i += 1;
        continue;
      }
      break;
    }
    if (i < words.length) found.push({ name: path.basename(words[i]), args: words.slice(i + 1) });
  }
  return found;
}

/**
 * Whether a command line sends output into a file.
 *
 * Scanned character by character with the quote state tracked, because `>` inside a string
 * is an argument and `>` outside one is a write, and every command in the read list becomes
 * a way to overwrite a file the moment a redirection is allowed past. `>&` is excluded: it
 * duplicates a descriptor, which is how `2>&1` is spelled and is not a file.
 */
export function redirectsOutput(command) {
  let quote = null;
  const text = String(command);
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\" && quote === '"') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "\\") { i += 1; continue; }
    if (ch === ">" && text[i + 1] !== "&") return true;
  }
  return false;
}

/**
 * The commands inside `$( )` and backticks, which run before the outer one does.
 *
 * A substitution is a command line of its own, so it is judged as one. Without this,
 * `echo $(rm -rf build)` is an echo.
 */
export function substitutions(command) {
  const found = [];
  const text = String(command);
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "$" && text[i + 1] === "(") {
      let depth = 1;
      let j = i + 2;
      while (j < text.length && depth > 0) {
        if (text[j] === "(") depth += 1;
        else if (text[j] === ")") depth -= 1;
        j += 1;
      }
      found.push(text.slice(i + 2, j - 1));
      i = j - 1;
    } else if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end === -1) break;
      found.push(text.slice(i + 1, end));
      i = end;
    }
  }
  return found;
}

/** Whether one command is read-only, a diagnostic, or something that may write. */
export function classifyCommand(name, args) {
  // `sed -i` edits in place, and is otherwise the same program as the one that prints.
  // `-i` and `--in-place` both, and GNU's `-i.bak` form, which is one word.
  if (name === "sed" && args.some((a) => a === "-i" || a.startsWith("-i") || a === "--in-place")) {
    return "write";
  }
  if (name === "perl" && args.some((a) => a.startsWith("-i"))) return "write";
  if (name === "git") {
    const sub = args.find((a) => !a.startsWith("-")) ?? "";
    // `git stash` and `git worktree` have mutating subcommands of their own; the plain
    // listing forms are the only ones worth reading, and the rest fall through as writes.
    if (sub === "stash" && args.includes("list")) return "read";
    if (sub === "worktree" && args.includes("list")) return "read";
    if (sub === "stash" || sub === "worktree") return "write";
    return READ_GIT.includes(sub) ? "read" : "write";
  }
  const mutating = MUTATING_SUBCOMMANDS[name];
  if (mutating) {
    const sub = args.find((a) => !a.startsWith("-")) ?? "";
    if (mutating.includes(sub)) return "write";
    return "diagnostic";
  }
  if (READ_COMMANDS.includes(name)) return "read";
  if (DIAGNOSTIC_COMMANDS.includes(name)) return "diagnostic";
  return "write";
}

/**
 * What the current state says about a tool call.
 *
 * Returns `{ allow, reason }`. The reason is written for the agent to read in a hook's
 * output, so it says what is forbidden, why, and which transition would make it legal.
 */
export function judge(state, { tool, command, path: target }) {
  const rules = STATES[state.state];
  if (!rules) return { allow: false, reason: `unknown state ${state.state}` };

  const writesFiles = ["Edit", "Write", "NotebookEdit", "MultiEdit"].includes(tool);
  if (writesFiles) {
    if (rules.mutation !== "allowed") {
      return {
        allow: false,
        reason:
          `${tool} is a mutation and this session is in ${state.state}, where mutation is ` +
          `${rules.mutation}. Finish the diagnosis first: record a hypothesis with ` +
          `"cb hypothesis add", run an experiment that could falsify it, and then ` +
          `"cb transition patch --hypothesis <id>" with the one it confirmed.`,
      };
    }
    if (state.state === "INACTIVE") return { allow: true, reason: "no session is open here" };
    if (!state.activeFix) {
      return {
        allow: false,
        reason:
          "PATCH was entered without a confirmed hypothesis, so there is nothing this " +
          "edit is a fix for. Run cb transition patch --hypothesis <id>.",
      };
    }
    return { allow: true, reason: `patching for ${state.activeFix.hypothesis}` };
  }

  if (tool !== "Bash") return { allow: true, reason: "not a mutation" };

  const line = command ?? "";
  if (rules.shell !== "any" && redirectsOutput(line)) {
    return {
      allow: false,
      reason:
        `${state.state} forbids this command: it redirects output into a file, which is a ` +
        `write however harmless the program in front of it looks. Read into the transcript ` +
        `instead, or make the change in PATCH.`,
    };
  }

  // Everything a substitution runs, judged before the line that contains it.
  for (const inner of substitutions(line)) {
    const verdict = judge(state, { tool: "Bash", command: inner });
    if (!verdict.allow) {
      return { allow: false, reason: `inside $( ): ${verdict.reason}` };
    }
  }

  const commands = leadingCommands(line);
  if (commands.length === 0) return { allow: true, reason: "empty command" };
  for (const { name, args } of commands) {
    const kind = classifyCommand(name, args);
    if (kind === "read") continue;
    if (kind === "diagnostic" && (rules.shell === "diagnostic" || rules.shell === "any")) continue;
    if (rules.shell === "any") continue;
    const why =
      kind === "diagnostic"
        ? `${name} runs code, which ${state.state} does not permit. cb transition experiment ` +
          `once a hypothesis names what this run would discriminate.`
        : `${name} is not on the read-only list, so it is treated as a write. ` +
          `If it only reads, say so and run it in EXPERIMENT; if it writes, it belongs in PATCH.`;
    return { allow: false, reason: `${state.state} forbids this command. ${why}` };
  }
  return { allow: true, reason: "read-only" };
}

/** Whether a completion claim is supported, and what is missing if it is not. */
export function judgeStop(state, root = projectDir()) {
  if (state.state === "INACTIVE") {
    return { allow: true, reason: "no session is open here", missing: [] };
  }
  const now = diffHash(root);
  const changed = now !== state.diffHash;
  const missing = [];

  if (!changed && !state.verification) {
    // Nothing was changed and nothing was claimed fixed: an investigation may end here.
    return { allow: true, reason: "no change was made in this session", missing };
  }

  if (!state.verification) {
    missing.push("no verification has been recorded; run the original reproduction and cb gate it");
  } else if (state.verification.diffHash !== now) {
    missing.push(
      `the verification was recorded against diff ${state.verification.diffHash} and the tree ` +
        `is now ${now}, so it is stale; re-run it`,
    );
  } else {
    for (const gate of GATES.filter((g) => g.critical)) {
      const result = state.verification.gates?.[gate.id];
      if (!result || result.result !== "pass") {
        missing.push(`${gate.id} (${gate.what}) is ${result?.result ?? "not recorded"}`);
      }
    }
  }

  if (state.state === "PATCH") missing.push("the session is still in PATCH; verification has not begun");

  return {
    allow: missing.length === 0,
    reason: missing.length === 0 ? "verified against the current tree" : "verification is incomplete",
    missing,
  };
}

// ---------------------------------------------------------------------------
// The command line.
// ---------------------------------------------------------------------------

function flags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const [key, inline] = arg.slice(2).split("=");
      if (inline !== undefined) out[key] = inline;
      else if (argv[i + 1] && !argv[i + 1].startsWith("--")) out[key] = argv[++i];
      else out[key] = true;
    } else out._.push(arg);
  }
  return out;
}

function need(opts, name) {
  if (!opts[name] || opts[name] === true) {
    process.stderr.write(`cb: --${name} is required\n`);
    process.exit(1);
  }
  return String(opts[name]);
}

const COMMANDS = {
  init(opts, root) {
    const state = emptyState(root);
    save(state, root);
    process.stdout.write(`circuit-breaker initialised in ${state.state} at ${stateFile(root)}\n`);
  },

  end(opts, root) {
    const file = stateFile(root);
    if (fs.existsSync(file)) {
      // Kept rather than deleted: the log is what a person reads when they want to know
      // why a session concluded what it did, and the next `cb init` overwrites it anyway.
      fs.renameSync(file, `${file}.${Date.now()}.closed`);
    }
    process.stdout.write("circuit-breaker: session closed, this project is ungoverned again\n");
  },

  status(opts, root) {
    const state = load(root);
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ ...state, treeNow: diffHash(root) }, null, 2)}\n`);
      return;
    }
    const open = state.hypotheses.filter((h) => h.status === "open");
    const confirmed = state.hypotheses.filter((h) => h.status === "confirmed");
    process.stdout.write(
      [
        `STATE: ${state.state}${state.suspendedFrom ? ` (suspended from ${state.suspendedFrom})` : ""}`,
        `TREE: ${diffHash(root)}${diffHash(root) === state.diffHash ? "" : ` (was ${state.diffHash})`}`,
        `HYPOTHESES: ${state.hypotheses.length} recorded, ${open.length} open, ${confirmed.length} confirmed`,
        `EXPERIMENTS: ${state.experiments.length}`,
        `ACTIVE FIX: ${state.activeFix ? state.activeFix.hypothesis : "none"}`,
        `VERIFICATION: ${state.verification ? `${Object.keys(state.verification.gates ?? {}).length} gates at ${state.verification.diffHash}` : "none"}`,
      ].join("\n") + "\n",
    );
  },

  hypothesis(opts, root) {
    const state = load(root);
    const [action, id] = opts._;
    if (action === "add") {
      const entry = {
        id: nextId(state.hypotheses, "H"),
        claim: need(opts, "claim"),
        because: need(opts, "because"),
        falsifier: need(opts, "falsifier"),
        status: "open",
        created: new Date().toISOString(),
      };
      state.hypotheses.push(entry);
      note(state, { event: "hypothesis", id: entry.id, claim: entry.claim });
      save(state, root);
      process.stdout.write(`${entry.id}\n`);
      return;
    }
    if (action === "confirm" || action === "reject") {
      const entry = state.hypotheses.find((h) => h.id === id);
      if (!entry) { process.stderr.write(`cb: no hypothesis ${id}\n`); process.exit(1); }
      // A hypothesis is confirmed by an experiment, not by a sentence: the evidence has to
      // exist and has to have been classified as supporting it.
      const support = state.experiments.filter(
        (e) => e.hypothesis === id && e.classification === "supports",
      );
      if (action === "confirm" && support.length === 0) {
        process.stderr.write(
          `cb: ${id} has no experiment classified "supports". Record one with ` +
            `cb experiment record --hypothesis ${id} ... --classification supports\n`,
        );
        process.exit(1);
      }
      entry.status = action === "confirm" ? "confirmed" : "rejected";
      note(state, { event: entry.status, id });
      save(state, root);
      process.stdout.write(`${id} ${entry.status}\n`);
      return;
    }
    for (const h of state.hypotheses) {
      process.stdout.write(`${h.id} [${h.status}] ${h.claim}\n    falsifier: ${h.falsifier}\n`);
    }
  },

  experiment(opts, root) {
    const state = load(root);
    if (opts._[0] !== "record") {
      for (const e of state.experiments) {
        process.stdout.write(`${e.id} ${e.hypothesis} [${e.classification}] ${e.command}\n`);
      }
      return;
    }
    const hypothesis = need(opts, "hypothesis");
    if (!state.hypotheses.some((h) => h.id === hypothesis)) {
      process.stderr.write(`cb: no hypothesis ${hypothesis}\n`);
      process.exit(1);
    }
    const classification = String(opts.classification ?? "");
    if (!["supports", "falsifies", "inconclusive"].includes(classification)) {
      process.stderr.write(
        `cb: --classification must be supports, falsifies or inconclusive. ` +
          `"interesting" and "seems likely" are not evidence states.\n`,
      );
      process.exit(1);
    }
    const entry = {
      id: nextId(state.experiments, "E"),
      hypothesis,
      command: need(opts, "command"),
      exit: Number.parseInt(String(opts.exit ?? "0"), 10),
      artifact: opts.artifact && opts.artifact !== true ? String(opts.artifact) : null,
      classification,
      at: new Date().toISOString(),
      diffHash: diffHash(root),
    };
    state.experiments.push(entry);
    note(state, { event: "experiment", id: entry.id, hypothesis, classification });
    save(state, root);
    process.stdout.write(`${entry.id}\n`);
  },

  transition(opts, root) {
    const state = load(root);
    const target = String(opts._[0] ?? "").toUpperCase();
    if (target === "RESUME") {
      if (state.state !== "SUSPENDED") {
        process.stderr.write(`cb: not suspended\n`);
        process.exit(1);
      }
      state.state = state.suspendedFrom ?? "OBSERVE";
      state.suspendedFrom = null;
      note(state, { event: "resume", to: state.state });
      save(state, root);
      process.stdout.write(`${state.state}\n`);
      return;
    }
    if (!STATES[target]) { process.stderr.write(`cb: unknown state ${target}\n`); process.exit(1); }
    const allowed = STATES[state.state].next;
    if (target === "SUSPENDED") {
      state.suspendedFrom = state.state;
    } else if (!allowed.includes(target)) {
      process.stderr.write(
        `cb: ${state.state} does not lead to ${target}. It leads to ${allowed.join(", ")}.\n`,
      );
      process.exit(1);
    }
    if (target === "PATCH") {
      const id = need(opts, "hypothesis");
      const entry = state.hypotheses.find((h) => h.id === id);
      if (!entry) { process.stderr.write(`cb: no hypothesis ${id}\n`); process.exit(1); }
      if (entry.status !== "confirmed") {
        process.stderr.write(
          `cb: ${id} is ${entry.status}. A patch needs a cause an experiment confirmed, ` +
            `not one that is merely open.\n`,
        );
        process.exit(1);
      }
      // Unreachable while the graph is what it is, and kept anyway. The only route from
      // PATCH back to PATCH passes through VERIFY and HYPOTHESIZE, and that arm clears the
      // fix as the reset a failed verification asks for, so `activeFix` is null by the time
      // anything arrives here. An edge added later would make it reachable again, and the
      // rule it carries is the one that makes a failure name a single cause.
      if (state.activeFix && state.activeFix.hypothesis !== id) {
        process.stderr.write(
          `cb: a fix for ${state.activeFix.hypothesis} is already open. One at a time, so a ` +
            `failure names one cause.\n`,
        );
        process.exit(1);
      }
      state.activeFix = { hypothesis: id, started: new Date().toISOString() };
    }
    if (target === "VERIFY") {
      // A verification records itself against the tree it ran on, and entering VERIFY is
      // where that tree is fixed. Anything recorded before this is about another tree.
      state.verification = { at: new Date().toISOString(), diffHash: diffHash(root), gates: {} };
    }
    if (target === "HYPOTHESIZE" && state.state === "VERIFY") {
      // The reset after a failed fix: the patch is no longer the answer and the next
      // hypothesis starts without it being assumed.
      state.activeFix = null;
    }
    const from = state.state;
    state.state = target;
    state.since = new Date().toISOString();
    state.diffHash = diffHash(root);
    note(state, { event: "transition", from, to: target });
    save(state, root);
    process.stdout.write(`${from} -> ${target}\n`);
  },

  gate(opts, root) {
    const state = load(root);
    const id = String(opts._[0] ?? "");
    if (!GATES.some((g) => g.id === id)) {
      process.stderr.write(`cb: unknown gate ${id}. Known: ${GATES.map((g) => g.id).join(", ")}\n`);
      process.exit(1);
    }
    const result = String(opts.result ?? "");
    if (!["pass", "fail", "unknown"].includes(result)) {
      process.stderr.write(`cb: --result must be pass, fail or unknown\n`);
      process.exit(1);
    }
    if (!state.verification) {
      process.stderr.write(`cb: no verification is open. cb transition verify first.\n`);
      process.exit(1);
    }
    state.verification.gates[id] = {
      result,
      evidence: opts.evidence && opts.evidence !== true ? String(opts.evidence) : null,
      at: new Date().toISOString(),
    };
    note(state, { event: "gate", id, result });
    save(state, root);
    process.stdout.write(`${id} ${result}\n`);
  },

  check(opts, root) {
    // Used by the hooks. Reads the tool call on the command line rather than stdin, so a
    // person can run the same check by hand while debugging the plugin itself.
    const state = load(root);
    const verdict = judge(state, {
      tool: String(opts.tool ?? ""),
      command: opts.command === true ? "" : String(opts.command ?? ""),
      path: opts.path === true ? "" : String(opts.path ?? ""),
    });
    process.stdout.write(`${verdict.reason}\n`);
    process.exit(verdict.allow ? 0 : 2);
  },

  "check-stop"(opts, root) {
    const state = load(root);
    const verdict = judgeStop(state, root);
    if (verdict.allow) { process.stdout.write(`${verdict.reason}\n`); return; }
    process.stdout.write(`${verdict.reason}:\n${verdict.missing.map((m) => `  - ${m}`).join("\n")}\n`);
    process.exit(2);
  },
};

export function main(argv) {
  const [name, ...rest] = argv;
  const root = projectDir();
  if (!name || name === "help" || name === "--help") {
    process.stdout.write(
      [
        "cb <command>",
        "",
        "  init                               start a session in OBSERVE",
        "  status [--json]                    where the session is",
        "  hypothesis add --claim --because --falsifier",
        "  hypothesis list | confirm <id> | reject <id>",
        "  experiment record --hypothesis <id> --command <cmd> --exit <n> [--artifact <path>]",
        "                    --classification supports|falsifies|inconclusive",
        "  transition <state> [--hypothesis <id>]",
        "  gate <id> --result pass|fail|unknown [--evidence <text>]",
        "  check --tool <name> [--command <cmd>] [--path <p>]   exit 2 if forbidden",
        "  check-stop                         exit 2 if completion is unsupported",
        "",
        `States: ${Object.keys(STATES).join(", ")}`,
      ].join("\n") + "\n",
    );
    return;
  }
  const command = COMMANDS[name];
  if (!command) { process.stderr.write(`cb: unknown command ${name}\n`); process.exit(1); }
  command(flags(rest), root);
}

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
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  "grep", "egrep", "fgrep", "rg", "ag", "find", "fd", "which", "type", "printenv",
  "sed", "awk", "sort", "uniq", "cut", "tr", "jq", "yq", "diff", "cmp", "column",
  "ps", "top", "lsof", "uptime", "uname", "sysctl", "ioreg", "vm_stat", "nm", "otool",
  "man", "less", "more", "tree", "basename", "dirname", "realpath", "readlink", "true",
  "cb",
  // Shell builtins that inspect or move about without writing anything.
  "cd", "pushd", "popd", "test", "[", "[[", "]]", "]", "false", ":", "printf", "shift",
  "set", "unset", "local", "export", "declare", "typeset", "wait", "jobs", "hash", "alias",
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
  // Exercising the running thing, which is what a verification of a UI or an API is. A
  // gate that can only be answered by a unit test is the substitution this plugin exists
  // to catch, so the tools that answer it properly have to be runnable.
  "playwright", "puppeteer", "cypress", "webdriver", "chromedriver", "selenium",
  "grpcurl", "websocat", "k6", "lighthouse", "axe", "newman", "hurl", "xcrun", "adb",
  // A server an experiment started is a server it has to be able to stop.
  "kill", "pkill", "killall", "lsof", "fuser",
];

/**
 * Tools that are not the shell, and what they are allowed to be.
 *
 * A browser or an API client is how a UI gate and an integration gate get answered, so
 * these are diagnostics rather than mutations: they drive the running application without
 * changing its source. Reading a page is a read. Anything not named here is left alone,
 * because a controller that denied tools it had never heard of would break sessions it
 * knows nothing about.
 */
const TOOL_KINDS = {
  read: [
    /^mcp__.*__(read_page|get_page_text|read_console_messages|read_network_requests)$/,
    /^mcp__.*__(tabs_context_mcp|list_connected_browsers|shortcuts_list|find)$/,
    /^(WebFetch|WebSearch|Read|Grep|Glob)$/,
  ],
  diagnostic: [
    // Navigating, clicking, typing and scripting: side effects in the application under
    // test, which is the point of a verification and not something OBSERVE should do.
    /^mcp__.*__(navigate|computer|form_input|javascript_tool|file_upload|upload_image)$/,
    /^mcp__.*__(browser_batch|shortcuts_execute|resize_window|gif_creator)$/,
    /^mcp__.*__(tabs_create_mcp|tabs_close_mcp|select_browser|switch_browser)$/,
  ],
};

/**
 * MCP verbs that change something, whichever server provides them.
 *
 * An allowlist of browser verbs left every other server unjudged, and `classifyTool`
 * returning null meant "not a mutation", so `mcp__filesystem__write_file` wrote a file in
 * OBSERVE without the gate noticing. Servers are named by their author, so the verb is
 * matched rather than the server.
 */
const MCP_WRITE_VERBS =
  /__(write|create|update|edit|delete|remove|move|rename|copy|append|put|post|patch|push|commit|merge|upload|insert|set|add|apply|install|execute|run|exec)(_|$)/;

/** What a non-shell tool counts as, or `null` when nothing is known about it. */
export function classifyTool(tool) {
  const name = String(tool ?? "");
  for (const [kind, patterns] of Object.entries(TOOL_KINDS)) {
    if (patterns.some((re) => re.test(name))) return kind;
  }
  if (name.startsWith("mcp__") && MCP_WRITE_VERBS.test(name)) return "write";
  return null;
}

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

/**
 * How to run this CLI, as a string an agent can paste into a shell.
 *
 * `cb` is not on anyone's PATH. A plugin cannot put it there, and it lives under a cache
 * directory whose name contains a version. A deny message that says "run cb hypothesis add"
 * is an instruction the agent cannot follow, which is worse than no instruction: it is
 * blocked and sent somewhere that does not exist. So every message this file produces
 * names the absolute path it was loaded from.
 */
const CB_BIN = fileURLToPath(new URL("../bin/cb", import.meta.url));
export const CB = `node ${JSON.stringify(CB_BIN)}`;

/**
 * The headings an investigation report has to carry.
 *
 * The spec's point is that this is not a style preference: open prose is where an
 * acknowledgement, an apology and a hedge go, and a slot named BLOCKED BY is answered or
 * visibly empty. Checked as headings on their own line, so the content is the model's.
 */
export const REPORT_HEADINGS = [
  "STATE:", "OBSERVATIONS:", "HYPOTHESES:", "DISCONFIRMING TEST:", "RESULT:",
  "NEXT ACTION:", "BLOCKED BY:",
];

/** Which of the report headings a message is missing. */
export function missingHeadings(message) {
  const lines = String(message ?? "").split("\n").map((l) => l.trim());
  return REPORT_HEADINGS.filter((h) => !lines.some((l) => l.startsWith(h)));
}

/**
 * The project root.
 *
 * The hooks pass the `cwd` from their event as a hint, and it is only a hint: the state
 * file belongs beside the repository, not beside whichever directory the session happens
 * to be sitting in, or a `cd` into a subdirectory would start a second empty session.
 */
export function projectDir(hint) {
  // Resolved, because a relative value made the state file relative too, and the session
  // then existed at the root and did not exist one directory down.
  const env = process.env.CLAUDE_PROJECT_DIR;
  const from = env ? path.resolve(env) : hint ? path.resolve(hint) : process.cwd();

  // An open session anywhere above wins, before git is consulted at all. Without this a
  // nested repository, or a project git does not track, resolved to a different root where
  // no state file exists, and no state file means INACTIVE, and INACTIVE permits
  // everything. The gate failed open in precisely the place it was needed.
  for (let dir = from; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, ".claude", "circuit-breaker", "state.json"))) return dir;
    if (dir === path.dirname(dir)) break;
  }

  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      cwd: from,
    }).trim();
  } catch {
    return from;
  }
}

/** Whether `root` is inside a git working tree. */
export function isGitRepo(root) {
  try {
    return execFileSync("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim() === "true";
  } catch {
    return false;
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
export const UNKNOWN_TREE = "unknown";

/**
 * A fingerprint of the working tree, so a verification can be told from a stale one.
 *
 * Every git call is checked, and a failure returns UNKNOWN_TREE rather than a hash. The
 * previous version swallowed failures and returned the empty string, which is exactly what
 * a clean tree produces, so three different disasters all looked like "nothing changed":
 * a repository with no commits, a diff larger than the output buffer, and git missing
 * altogether. A verification recorded against a tree and then measured against 32 MB of
 * new content passed, because both hashed the same. A fingerprint that cannot fail is not
 * a fingerprint.
 *
 * The diff goes to a file and is read back in chunks rather than buffered, because
 * `git diff HEAD` on a large repository is hundreds of megabytes and the buffer limit was
 * where the collision came from.
 *
 * Tracked changes and the names of untracked files. The names rather than the contents of
 * untracked files, because an untracked build artifact changing every run would invalidate
 * every verification and teach the reader to ignore the field.
 */
export function diffHash(root = projectDir()) {
  let failed = false;
  const run = (args) => {
    try {
      return execFileSync("git", ["-C", root, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 16 * 1024 * 1024,
      });
    } catch {
      failed = true;
      return "";
    }
  };

  const head = run(["rev-parse", "HEAD"]).trim();
  if (failed) return UNKNOWN_TREE;

  const hash = createHash("sha256");
  hash.update(`${head}\n`);

  // The diff is written out and streamed back, so its size cannot decide the answer.
  const EXCLUDE = [":(exclude).claude/circuit-breaker/**"];
  try {
    const buffered = execFileSync("git", ["-C", root, "diff", "HEAD", "--", ".", ...EXCLUDE], {
      encoding: "buffer",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 16 * 1024 * 1024,
    });
    hash.update(buffered);
    return finish();
  } catch (error) {
    // ENOBUFS only means the diff is large. Anything else is git failing, and a fingerprint
    // that cannot be computed must say so rather than return the hash of a clean tree.
    if (error.code !== "ENOBUFS") return UNKNOWN_TREE;
  }

  const scratch = path.join(os.tmpdir(), `cb-diff-${process.pid}-${Date.now()}`);
  const sweep = () => { try { fs.unlinkSync(scratch); } catch { /* nothing to remove */ } };
  process.once("SIGTERM", sweep);
  process.once("SIGINT", sweep);
  try {
    run(["diff", "HEAD", `--output=${scratch}`, "--", ".", ...EXCLUDE]);
    if (failed) return UNKNOWN_TREE;
    const fd = fs.openSync(scratch, "r");
    try {
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      for (;;) {
        const read = fs.readSync(fd, buffer, 0, buffer.length, null);
        if (read <= 0) break;
        hash.update(buffer.subarray(0, read));
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return UNKNOWN_TREE;
  } finally {
    sweep();
  }
  return finish();

  // The controller's own state file is excluded, and this is not tidiness: it is written
  // on every transition and every gate, so counting it would make the tree differ from
  // itself between recording a verification and reading it back, and every session would
  // end blocked on a staleness it caused.
  return finish();

  function finish() {
  const untracked = run(["ls-files", "--others", "--exclude-standard"]);
  if (failed) return UNKNOWN_TREE;
  const paths = untracked
    .split("\n")
    .filter((line) => line && !line.startsWith(".claude/circuit-breaker/"))
    .sort();
  for (const rel of paths) {
    hash.update(`\n${rel}\n`);
    // The content too, not only the name. A fix written into a new module is the ordinary
    // case, and hashing names alone meant such a file could be rewritten wholesale after a
    // verification and the Stop gate would still call it fresh. `--exclude-standard` has
    // already dropped everything gitignored, which is where build churn lives.
    try {
      const full = path.join(root, rel);
      const size = fs.statSync(full).size;
      if (size > 8 * 1024 * 1024) { hash.update(`size:${size}`); continue; }
      hash.update(fs.readFileSync(full));
    } catch {
      hash.update("unreadable");
    }
  }
  return hash.digest("hex").slice(0, 16);
  }
}

/** Whether this repository has a commit, which is the baseline everything is measured from. */
export function hasCommit(root) {
  try {
    execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
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
  // No session means nothing to compare against, so the tree is not fingerprinted here.
  // Doing it cost a full `git diff` on every tool call in every project that merely had
  // the plugin installed, which on a large repository exceeded the hook's own timeout.
  if (!fs.existsSync(file)) {
    return {
      version: STATE_VERSION, state: "INACTIVE", since: new Date().toISOString(),
      diffHash: UNKNOWN_TREE, suspendedFrom: null, hypotheses: [], experiments: [],
      activeFix: null, verification: null, log: [],
    };
  }
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  if (raw.version !== STATE_VERSION) {
    throw new Error(`state file is version ${raw.version}, this cb speaks ${STATE_VERSION}`);
  }
  // Shape, not just version. A file missing `log` or `hypotheses` crashed the hooks on the
  // first field access, and a crashed hook is a hook that did not deny.
  return {
    ...raw,
    hypotheses: Array.isArray(raw.hypotheses) ? raw.hypotheses : [],
    experiments: Array.isArray(raw.experiments) ? raw.experiments : [],
    log: Array.isArray(raw.log) ? raw.log : [],
  };
}

/**
 * Run `mutate` against the freshest state, with other writers held off.
 *
 * `save` writes atomically, but load-modify-save is not atomic, and the PostToolUse hook
 * writes at the same time as the agent's own `cb` calls. Twenty parallel `hypothesis add`
 * calls lost ten of them and told five callers they had created H2. A directory is the
 * lock because mkdir is atomic on every filesystem worth having.
 */
export function withLock(root, mutate) {
  const lock = path.join(path.dirname(stateFile(root)), "lock");
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + 2000;
  let held = false;
  for (;;) {
    try { fs.mkdirSync(lock); held = true; break; } catch {
      // A lock older than the deadline belonged to something that died holding it.
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 30000) { fs.rmdirSync(lock); continue; }
      } catch { /* it was released while we looked */ }
      if (Date.now() > deadline) break;
    }
  }
  try {
    return mutate();
  } finally {
    // Only the holder releases it. Removing it on the way past a timeout deleted somebody
    // else's lock and put back the race this exists to stop.
    if (held) { try { fs.rmdirSync(lock); } catch { /* already gone */ } }
  }
}

export function save(state, root = projectDir()) {
  const file = stateFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Written beside the target and renamed, because a PreToolUse hook can be killed
  // mid-write when the user interrupts, and a truncated state file would deny every
  // subsequent tool call with a parse error.
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* it may never have been created */ }
    throw new Error(
      `the circuit-breaker state at ${file} could not be written (${error.code ?? error.message}). ` +
      `The session cannot record anything until that is fixed.`,
    );
  }
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
 * A command line, taken apart with the quotes respected.
 *
 * The previous version of this split on a regular expression and took the first word of
 * each piece, which is the wrong shape for the job in a way that only shows up under
 * attack. It missed `&` as a separator, so `true & rm f.txt` was judged as `true`. It was
 * blind to quoting, so `$'\''` desynchronised it and `awk -F'|'` was torn in half. It did
 * not see `<(rm f)`. Every one of those was a proven write in a state where mutation is
 * denied.
 *
 * So the line is scanned once, character by character, tracking quote state, and what
 * comes back is what the gate needs to decide: the segments, each segment's words, and
 * three flags for constructs that have to be judged rather than skimmed.
 *
 * Returns `{ segments, redirects, subs, unsupported }`:
 *   segments   arrays of words, split on unquoted ; | || && & and newline
 *   redirects  true when output goes to a file that is not a discard device
 *   subs       command lines found inside $( ), backticks and <( )
 *   unsupported  a construct this lexer will not vouch for, such as a heredoc
 */
export function lexCommandLine(command, root = null) {
  const text = String(command ?? "");
  const segments = [];
  const subs = [];
  let words = [];
  let word = "";
  let quote = null;
  let redirects = false;
  let unsupported = null;

  const endWord = () => { if (word) { words.push(word); word = ""; } };
  const endSegment = () => { endWord(); if (words.length) segments.push(words); words = []; };

  /** Read a balanced construct starting at `i`, returning its body and the index after it. */
  const balanced = (i, open, close) => {
    let depth = 1;
    let j = i;
    let q = null;
    while (j < text.length && depth > 0) {
      const c = text[j];
      if (q) { if (c === "\\" && q === '"') j += 1; else if (c === q) q = null; }
      else if (c === "'" || c === '"') q = c;
      else if (c === "\\") j += 1;
      else if (c === open) depth += 1;
      else if (c === close) depth -= 1;
      j += 1;
    }
    return { body: text.slice(i, j - (depth === 0 ? 1 : 0)), next: j };
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (quote) {
      // Inside $'...' a backslash escapes the next character, including the closing quote.
      if (quote === "$'" && ch === "\\") { word += ch + (text[i + 1] ?? ""); i += 1; continue; }
      if (quote === '"' && ch === "\\") { word += ch + (text[i + 1] ?? ""); i += 1; continue; }
      if ((quote === "$'" && ch === "'") || (quote !== "$'" && ch === quote)) { quote = null; continue; }
      word += ch;
      continue;
    }

    if (ch === "$" && text[i + 1] === "'") { quote = "$'"; i += 1; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "\\") { word += text[i + 1] ?? ""; i += 1; continue; }
    if (ch === "#" && !word && !words.length) { break; } // a whole-line comment

    // $( ) and ` ` and <( ) each run a command line of their own.
    if (ch === "$" && text[i + 1] === "(") {
      const { body, next } = balanced(i + 2, "(", ")");
      subs.push(body); i = next - 1; word += " "; continue;
    }
    if (ch === "`") {
      const close = text.indexOf("`", i + 1);
      if (close === -1) { unsupported = "an unterminated backtick"; break; }
      subs.push(text.slice(i + 1, close)); i = close; word += " "; continue;
    }
    if ((ch === "<" || ch === ">") && text[i + 1] === "(") {
      const { body, next } = balanced(i + 2, "(", ")");
      subs.push(body); i = next - 1; word += " "; continue;
    }
    if (ch === "$" && text[i + 1] === "{") { const { next } = balanced(i + 2, "{", "}"); i = next - 1; word += " "; continue; }

    // A heredoc body is data, not commands, and this lexer will not pretend to know where
    // it ends. Saying so is better than judging `hello world` as a command called `hello`.
    if (ch === "<" && text[i + 1] === "<") { unsupported = "a heredoc"; break; }

    if (ch === ">" || ch === "<") {
      if (ch === ">") {
        let j = i + 1;
        if (text[j] === ">") j += 1;
        // `>&word` is a file redirect unless the word is a descriptor number or `-`.
        if (text[j] === "&") {
          const tail = text.slice(j + 1).trimStart();
          if (!/^(\d+|-)(\s|$|[;|&])/.test(tail)) {
            const target = tail.split(/[\s;|&]/)[0] ?? "";
            if (!isDiscardTarget(target, root)) redirects = true;
          }
          i = j; endWord(); continue;
        }
        const target = text.slice(j).trimStart().split(/[\s;|&<>]/)[0] ?? "";
        if (!isDiscardTarget(target, root)) redirects = true;
      }
      endWord();
      continue;
    }

    if (ch === ";" || ch === "\n") { endSegment(); continue; }
    if (ch === "|") { if (text[i + 1] === "|") i += 1; endSegment(); continue; }
    if (ch === "&") { if (text[i + 1] === "&") i += 1; endSegment(); continue; }
    if (ch === "(" || ch === ")" || ch === "{" || ch === "}") { endSegment(); continue; }
    if (/\s/.test(ch)) { endWord(); continue; }
    word += ch;
  }
  if (quote) unsupported = unsupported ?? "an unterminated quote";
  endSegment();
  return { segments, redirects, subs, unsupported };
}

/** Whether a redirection target throws the bytes away rather than keeping them. */
function isDiscardTarget(target, root = null) {
  const clean = target.replace(/^["']|["']$/g, "");
  if (/^\/dev\/(null|stdout|stderr|fd\/\d+|tty)$/.test(clean)) return true;
  // Somewhere to put a benchmark's output, which `experiment record --artifact` asks for
  // and the gate would otherwise never let an experiment create. The temp directory only:
  // "anywhere outside the project" would have included /etc/hosts and the user's own
  // dotfiles, which is not what an experiment needs and not a trade worth making.
  // Both spellings: os.tmpdir() is /var/folders/... on macOS while everyone writes /tmp.
  const scratches = [path.resolve(os.tmpdir()), "/tmp", "/private/tmp"];
  const resolved = path.isAbsolute(clean) ? path.resolve(clean) : null;
  return resolved !== null && scratches.some((dir) => resolved.startsWith(`${dir}${path.sep}`));
}

/**
 * The commands a line will run, each with the wrappers stripped from the front.
 *
 * `env`, `time`, `nice` and the rest are not commands in their own right here: they take a
 * command and run it, so judging them as themselves made every one of them a way to run
 * anything. `cd` is stripped because `cd x && ls` is the commonest line in the language and
 * refusing it made OBSERVE unusable.
 */
const WRAPPERS = new Set([
  "sudo", "command", "exec", "nohup", "env", "time", "nice", "ionice", "timeout", "stdbuf",
  "xcrun", "setsid", "chroot", "doas", "script", "caffeinate", "watch", "xargs",
]);

/**
 * Leading words to step over, after which the rest of the segment is still a command.
 * `if grep -q x f` runs grep, and `do rm x` runs rm, so neither may be waved through.
 */
const SKIP_WORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "}"]);

/** Leading words after which the segment is a construct header and runs no command. */
const HEADER_WORDS = new Set(["for", "select", "case", "in", "esac", "fi", "done", "function"]);

function leadingCommands(command) {
  const { segments } = lexCommandLine(command);
  const found = [];
  for (const words of segments) {
    let i = 0;
    while (i < words.length) {
      const w = words[i];
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) { i += 1; continue; }
      if (WRAPPERS.has(path.basename(w))) {
        const wrapper = path.basename(w);
        i += 1;
        // Skip the wrapper's own flags and, for `env`, its VAR=value arguments.
        while (i < words.length && (words[i].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]))) i += 1;
        // `timeout` and `nice` take a value before the command, and treating that value as
        // the command made `timeout 5 ./repro.sh` a command called `5`.
        if ((wrapper === "timeout" || wrapper === "nice") && /^[\d.]+[smhd]?$/.test(words[i] ?? "")) i += 1;
        continue;
      }
      if (HEADER_WORDS.has(w)) { i = words.length; break; }
      if (SKIP_WORDS.has(w)) { i += 1; continue; }
      break;
    }
    if (i < words.length) {
      found.push({ name: path.basename(words[i]), raw: words[i], args: words.slice(i + 1) });
    }
  }
  return found;
}

/**
 * `find` actions that do something to what they found.
 *
 * `find` reads until you give it one of these, and then it is whatever it was told to run.
 * `-exec rm` is the obvious one and `-fprintf` is the one nobody remembers.
 */
const FIND_ACTIONS = [
  "-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls",
];

/**
 * Read-listed commands that write when given the right argument.
 *
 * A name alone does not say what a command does. `sort -o src.txt` overwrites source and
 * `sed -n "w src.txt"` does too, both while being called a read. Each entry says what to
 * look for in the arguments.
 */
const WRITE_FLAGS = {
  sort: (args) => args.some((a) => a === "-o" || a.startsWith("--output")),
  // uniq's second positional argument is an output file.
  uniq: (args) => args.filter((a) => !a.startsWith("-")).length >= 2,
  sed: (args) => args.some((a) => a === "-i" || a.startsWith("-i") || a.startsWith("--in-place")) ||
    args.some((a) => /(^|[;}\/])\s*w\s+\S/.test(a)),
  perl: (args) => args.some((a) => /^-[a-zA-Z]*i/.test(a)),
  curl: (args) => args.some((a) => ["-o", "-O", "--output", "--remote-name"].includes(a)),
  http: (args) => args.some((a) => a === "--download" || a === "-d"),
  tee: () => true,
  fd: (args) => args.some((a) => a === "-x" || a === "-X" || a.startsWith("--exec")),
};

/** Subcommand forms of `git config` that only read. Anything else sets something. */
const READ_GIT_CONFIG = ["--get", "--get-all", "--get-regexp", "--get-urlmatch", "--list", "-l"];

/**
 * Whether an `awk` program writes.
 *
 * awk redirects with `>` and `>>` and pipes with `|` from inside its own program text,
 * where the shell cannot see it, and `system()` runs anything at all. Telling
 * `print > "out"` from `$1 > 5` needs an awk parser, so this does not try: a program
 * containing any of them is a write. That denies a comparison in OBSERVE, which costs one
 * transition, and the alternative costs the guarantee.
 */
function awkWrites(args) {
  // The program is the first argument that is not a flag. The lexer preserves quoting, so
  // it arrives whole; reading every argument instead made `awk -F'|'` look like a pipe.
  const program = args.find((a) => !a.startsWith("-")) ?? "";
  return /[>|]/.test(program) || program.includes("system(");
}

/**
 * The controller's own subcommand, if this command line is the controller.
 *
 * It arrives two ways and both have to be recognised. `cb status` is what a person with an
 * alias types. `node "/abs/path/bin/cb" status` is what the agent is told to run, because
 * `cb` is on nobody's PATH, and there the leading word is `node`: the CLI is an argument.
 * Missing that form deadlocked a real session. OBSERVE told it to record a hypothesis, then
 * denied `node` as a thing that runs code, so the only route out of the state was the one
 * command the state forbade.
 *
 * Only when the CLI is the first non-flag argument, so `node -e '<code>' bin/cb` stays a
 * script that runs code rather than becoming a free pass.
 */
export function cbSubcommand(name, args, raw = name) {
  const nonFlag = args.filter((a) => !a.startsWith("-"));
  if (isThisCli(raw) || name === "cb") return nonFlag[0] ?? "";
  if (["node", "bun", "deno"].includes(name) && nonFlag[0] && isThisCli(nonFlag[0])) {
    return nonFlag[1] ?? "";
  }
  return null;
}

/**
 * Whether a word names this controller's own binary.
 *
 * Resolved rather than compared by spelling: a symlink under another name, and a copy
 * reached by a different relative path, are both still the command that can close the
 * session, and a guard that matched the string `cb` missed both of them.
 */
function isThisCli(word) {
  const candidate = String(word).replace(/^["']|["']$/g, "");
  if (/(^|[/\\])cb$/.test(candidate)) return true;
  try {
    return fs.realpathSync(candidate) === fs.realpathSync(CB_BIN);
  } catch {
    return false;
  }
}

/** Whether one command is read-only, a diagnostic, or something that may write. */
export function classifyCommand(name, args, raw = name) {
  // The controller reads and writes its own ledger and nothing else, so it is allowed in
  // every state. Which of its subcommands an agent may run is a separate question, decided
  // in `judge` where the state is known.
  if (cbSubcommand(name, args, raw) !== null) return "read";
  // A path to a local executable is the project's own script: `./repro.sh`, `./bench.sh`,
  // `scripts/build.sh`. That is what an experiment runs and what answers the reproduction
  // gate, so treating it as an unknown write made EXPERIMENT and VERIFY unable to do the
  // one thing they exist for. It is a diagnostic, which is no weaker than the `node` and
  // `make` already on that list: both run arbitrary code and can write. OBSERVE still
  // refuses it, because OBSERVE refuses everything that runs.
  //
  // Relative only. An absolute path is classified by its basename instead, so `/bin/rm`
  // stays the write that `rm` is and `/usr/bin/node` stays the diagnostic that `node` is.
  if (!raw.startsWith("/") && raw.includes("/")) return "diagnostic";
  // `sed -i` edits in place, and is otherwise the same program as the one that prints.
  // `-i` and `--in-place` both, and GNU's `-i.bak` form, which is one word.
  if (name === "sed" && args.some((a) => a === "-i" || a.startsWith("-i") || a === "--in-place")) {
    return "write";
  }
  if (name === "perl" && args.some((a) => a.startsWith("-i"))) return "write";
  if (name === "find" || name === "fd") {
    if (args.some((a) => FIND_ACTIONS.includes(a))) return "write";
  }
  if (name === "awk" || name === "gawk" || name === "mawk" || name === "nawk") {
    if (awkWrites(args)) return "write";
  }
  if (name === "git") {
    const sub = args.find((a) => !a.startsWith("-")) ?? "";
    // `git stash` and `git worktree` have mutating subcommands of their own; the plain
    // listing forms are the only ones worth reading, and the rest fall through as writes.
    // The reading form of these is the word `list` as the SUBCOMMAND, not anywhere in the
    // line. `git stash push -m list` reverted an agent's uncommitted work while being
    // called a read, and `git worktree add list` created a directory and a branch.
    const after = args.filter((a) => !a.startsWith("-"));
    if (sub === "stash" || sub === "worktree") {
      // Bare `git stash` is `git stash push`: it would revert the very patch a session is
      // verifying. Only the explicit listing form reads.
      return after[1] === "list" ? "read" : "write";
    }
    // `git branch` and `git remote` read when listing and write with anything else.
    if (sub === "branch" || sub === "remote") {
      const writesBranch = args.some((a) => /^-(d|D|m|M|c|C)$/.test(a) || a === "--delete" || a === "--move");
      const writesRemote = ["add", "remove", "rm", "rename", "set-url", "prune"].includes(after[1]);
      return writesBranch || writesRemote || (sub === "branch" && after.length > 1) ? "write" : "read";
    }
    // `git config x y` sets x. Only the reading forms are reads.
    if (sub === "config") {
      return args.some((a) => READ_GIT_CONFIG.includes(a)) ? "read" : "write";
    }
    return READ_GIT.includes(sub) ? "read" : "write";
  }
  const mutating = MUTATING_SUBCOMMANDS[name];
  if (mutating) {
    const sub = args.find((a) => !a.startsWith("-")) ?? "";
    if (mutating.includes(sub)) return "write";
    return "diagnostic";
  }
  if (READ_COMMANDS.includes(name)) {
    const writes = WRITE_FLAGS[name];
    return writes && writes(args) ? "write" : "read";
  }
  if (DIAGNOSTIC_COMMANDS.includes(name)) return "diagnostic";
  return "write";
}

/**
 * What the current state says about a tool call.
 *
 * Returns `{ allow, reason }`. The reason is written for the agent to read in a hook's
 * output, so it says what is forbidden, why, and which transition would make it legal.
 */
export function judge(state, { tool, command, path: target, root = null }, substitutionDepth = 0) {
  const rules = STATES[state?.state];
  if (!rules) {
    return {
      allow: false,
      reason:
        `the circuit-breaker state file says this session is in "${state?.state}", which is ` +
        `not a state. It has been corrupted or written by another tool. Ask for it to be ` +
        `repaired or for the session to be closed; until then nothing here is safe to judge.`,
    };
  }

  const writesFiles = ["Edit", "Write", "NotebookEdit", "MultiEdit"].includes(tool);
  if (writesFiles) {
    if (rules.mutation !== "allowed") {
      return {
        allow: false,
        reason:
          `${tool} is a mutation and this session is in ${state.state}, where mutation is ` +
          `${rules.mutation}. Finish the diagnosis first: record a hypothesis with ` +
          `${CB} hypothesis add, run an experiment that could falsify it, and then ` +
          `${CB} transition patch --hypothesis <id> with the one it confirmed.`,
      };
    }
    if (state.state === "INACTIVE") return { allow: true, reason: "no session is open here" };
    if (!state.activeFix) {
      return {
        allow: false,
        reason:
          "PATCH was entered without a confirmed hypothesis, so there is nothing this " +
          `edit is a fix for. Run ${CB} transition patch --hypothesis <id>.`,
      };
    }
    const cause = state.hypotheses.find((h) => h.id === state.activeFix.hypothesis);
    if (!cause || cause.status !== "confirmed") {
      return {
        allow: false,
        reason:
          `the fix in progress is for ${state.activeFix.hypothesis}, which is now ` +
          `${cause ? cause.status : "missing"}. A patch needs a cause that is still ` +
          `confirmed. Go back to HYPOTHESIZE and name what you are fixing instead.`,
      };
    }
    return { allow: true, reason: `patching for ${state.activeFix.hypothesis}` };
  }

  if (tool !== "Bash") {
    const kind = classifyTool(tool);
    if (kind === null || kind === "read") return { allow: true, reason: "not a mutation" };
    if (rules.shell === "diagnostic" || rules.shell === "any") {
      return { allow: true, reason: `${tool} drives the application under test` };
    }
    return {
      allow: false,
      reason:
        `${tool} acts on the running application, which ${state.state} does not permit. ` +
        `Reading a page is allowed here; clicking, typing and navigating belong in ` +
        `EXPERIMENT, where a hypothesis names what the interaction would discriminate, or ` +
        `in VERIFY, where it answers a gate.`,
    };
  }

  const line = command ?? "";
  const lexed = lexCommandLine(line, root);

  // A construct this lexer will not take apart is not a construct it may wave through.
  if (lexed.unsupported && rules.shell !== "any") {
    return {
      allow: false,
      reason:
        `${state.state} forbids this command: it contains ${lexed.unsupported}, which this ` +
        `gate does not read well enough to vouch for. Run it in a state that permits it, or ` +
        `write it without that construct.`,
    };
  }

  // Opening and closing the session are the two ways out of the controller rather than
  // through it. `cb end` releases the project. `cb init` rewrites the state file empty,
  // dropping the ledger and re-stamping the diff hash the Stop gate measures. Both are
  // denied to the agent in every state and every spelling; a person typing either in their
  // own terminal meets no hook and is unaffected.
  const open = state.state !== "INACTIVE";
  for (const { name, args, raw } of leadingCommands(line)) {
    const sub = cbSubcommand(name, args, raw);
    if (sub === null) continue;
    if (sub === "end" || (sub === "init" && open)) {
      return {
        allow: false,
        reason:
          sub === "end"
            ? `cb end closes the session and hands the project back unguarded, which is the ` +
              `one decision this controller does not take from you. Ask, and let them type ` +
              `it. Everything else is yours: hypothesis, experiment, transition, gate.`
            : `cb init would empty the ledger of a session already in ${state.state}, losing ` +
              `every hypothesis and experiment on record and resetting the tree the ` +
              `verification is measured against. If the diagnosis is wrong, reject the ` +
              `hypothesis and start another; do not reset the session.`,
      };
    }
  }

  if (rules.shell !== "any" && lexed.redirects) {
    return {
      allow: false,
      reason:
        `${state.state} forbids this command: it redirects output into a file, which is a ` +
        `write however harmless the program in front of it looks. Read into the transcript ` +
        `instead, or make the change in PATCH.`,
    };
  }

  // Everything a substitution runs, judged before the line that contains it. Depth-limited,
  // because a crafted nest of them used to recurse until the stack gave out, and a gate
  // that throws is a gate that does not deny.
  if (substitutionDepth > 8) {
    return { allow: false, reason: `${state.state} forbids this command: its substitutions nest too deeply to judge.` };
  }
  for (const inner of lexed.subs) {
    const verdict = judge(state, { tool: "Bash", command: inner, root }, substitutionDepth + 1);
    if (!verdict.allow) return { allow: false, reason: `inside a substitution: ${verdict.reason}` };
  }

  const commands = leadingCommands(line);
  if (commands.length === 0) return { allow: true, reason: "empty command" };
  for (const { name, args, raw } of commands) {
    const kind = classifyCommand(name, args, raw);
    if (kind === "read") continue;
    if (kind === "diagnostic" && (rules.shell === "diagnostic" || rules.shell === "any")) continue;
    if (rules.shell === "any") continue;
    const why =
      kind === "diagnostic"
        ? `${name} runs code, which ${state.state} does not permit. ${CB} transition experiment ` +
          `once a hypothesis names what this run would discriminate.`
        : READ_COMMANDS.includes(name) || name === "git"
          ? `${name} reads in most forms, but not in this one: these arguments write. ` +
            `Drop them and it is allowed here; keep them and it belongs in PATCH.`
          : `${name} is not on the read-only list, so it is treated as a write. ` +
            `If it only reads, say so and run it in EXPERIMENT; if it writes, it belongs in PATCH.`;
    return { allow: false, reason: `${state.state} forbids this command. ${why}` };
  }
  return { allow: true, reason: rules.shell === "any" ? "this state permits any command" : "reads, or runs without changing source" };
}

/** Whether a completion claim is supported, and what is missing if it is not. */
export function judgeStop(state, root = projectDir(), { lastMessage } = {}) {
  if (!STATES[state?.state]) {
    return {
      allow: false,
      reason: "the state file is unreadable",
      missing: [`the session state is "${state?.state}", which is not a state; the ledger cannot be trusted`],
    };
  }
  if (state.state === "INACTIVE") {
    return { allow: true, reason: "no session is open here", missing: [] };
  }
  const now = diffHash(root);
  if (now === UNKNOWN_TREE || state.diffHash === UNKNOWN_TREE) {
    return {
      allow: false,
      reason: "the working tree cannot be fingerprinted",
      missing: [
        "git could not describe this tree, so a verification cannot be told from a stale " +
        "one. Say plainly that the work is not verified, and why.",
      ],
    };
  }
  const changed = now !== state.diffHash;
  const missing = [];

  // The output contract, checked rather than requested. A session that is open is in the
  // investigation mode the schema belongs to, and the check runs even when nothing was
  // changed, because an investigation that concluded nothing still has to say what it
  // observed and what is still blocking. Only checked when the message is supplied.
  if (lastMessage !== undefined && lastMessage !== null && String(lastMessage).trim()) {
    const absent = missingHeadings(lastMessage);
    if (absent.length > 0) {
      missing.push(
        `the report is not in the investigation format; it has no ${absent.join(", ")} ` +
          `${absent.length === 1 ? "line" : "lines"}`,
      );
    }
  }

  if (!changed && !state.verification) {
    // Nothing was changed and nothing was claimed fixed: an investigation may end here,
    // provided it said so in the schema.
    return {
      allow: missing.length === 0,
      reason: missing.length === 0 ? "no change was made in this session" : "the report is incomplete",
      missing,
    };
  }

  if (!state.verification) {
    missing.push(`no verification has been recorded; run the original reproduction and record it with ${CB} gate`);
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
    if (isGitRepo(root) && !hasCommit(root)) {
      process.stderr.write(
        `cb: ${root} is a git repository with no commits, so there is no baseline to ` +
          `measure a change against. Every file is untracked, only their names are ` +
          `fingerprinted, and a verification would survive the source being rewritten. ` +
          `Make a first commit, then open the session.\n`,
      );
      process.exit(1);
    }
    if (!isGitRepo(root)) {
      process.stderr.write(
        `cb: ${root} is not a git repository, and every verification here is measured ` +
          `against a diff. Without one the Stop gate cannot tell a fresh check from a stale ` +
          `one and would pass anything, so a session would look enforced and would not be. ` +
          `Run git init first.\n`,
      );
      process.exit(1);
    }
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
    const tree = diffHash(root);
    const open = state.hypotheses.filter((h) => h.status === "open");
    const confirmed = state.hypotheses.filter((h) => h.status === "confirmed");
    process.stdout.write(
      [
        `STATE: ${state.state}${state.suspendedFrom ? ` (suspended from ${state.suspendedFrom})` : ""}`,
        `TREE: ${tree}${tree === state.diffHash ? "" : ` (was ${state.diffHash})`}`,
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
      if (action === "confirm" && entry.status === "rejected") {
        process.stderr.write(
          `cb: ${id} was rejected. Confirming it now would undo that verdict with one ` +
            `command, which is the whole point of having recorded it. Add a new hypothesis ` +
            `if the evidence has changed.\n`,
        );
        process.exit(1);
      }
      if (action === "confirm" && support.length === 0) {
        process.stderr.write(
          `cb: ${id} has no experiment classified "supports". Record one with ` +
            `${CB} experiment record --hypothesis ${id} ... --classification supports\n`,
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
      // Suspending twice must not overwrite where the session came from, or RESUME returns
      // to SUSPENDED and the only way out is to ask for it again.
      if (state.state !== "SUSPENDED") state.suspendedFrom = state.state;
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
      // Reachable, and the reason a session may only carry one open fix: a failure has to
      // name one cause. It is cleared when a verification sends the session back to a
      // hypothesis and when one finishes, so a second cause in the same session gets here
      // with nothing in the way.
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
    if (target === "DONE") {
      // A finished fix is not an open one. Without this a session that completed a cycle
      // could never patch a second cause: the guard above would still be holding the first
      // hypothesis, and the only way out would be to wipe the ledger with `cb init`.
      state.activeFix = null;
    }
    const from = state.state;
    state.state = target;
    state.since = new Date().toISOString();
    // `diffHash` is deliberately NOT re-stamped here. It is the tree as the session found
    // it, and the Stop gate asks whether anything changed since. Re-stamping it on every
    // transition meant a single `cb transition suspended` after an edit made the session
    // look as though it had changed nothing, and finishing unverified was allowed.
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
      process.stderr.write(`cb: no verification is open. ${CB} transition verify first.\n`);
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
      root,
    });
    process.stdout.write(`${verdict.reason}\n`);
    process.exit(verdict.allow ? 0 : 2);
  },

  "check-stop"(opts, root) {
    const state = load(root);
    const verdict = judgeStop(state, root, {
      lastMessage: opts.message === true ? undefined : opts.message,
    });
    if (verdict.allow) { process.stdout.write(`${verdict.reason}\n`); return; }
    process.stdout.write(`${verdict.reason}:\n${verdict.missing.map((m) => `  - ${m}`).join("\n")}\n`);
    process.exit(2);
  },
};

export function main(argv) {
  const [name, ...rest] = argv;
  const root = projectDir(process.cwd());
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
        "  check-stop [--message <report>]    exit 2 if completion is unsupported",
        "",
        `States: ${Object.keys(STATES).join(", ")}`,
      ].join("\n") + "\n",
    );
    return;
  }
  const command = COMMANDS[name];
  if (!command) { process.stderr.write(`cb: unknown command ${name}\n`); process.exit(1); }
  // Every command that reads the state and writes it back runs under the lock, so two of
  // them racing cannot lose an update or hand two callers the same id.
  const MUTATES = ["hypothesis", "experiment", "transition", "gate", "init", "end"];
  if (MUTATES.includes(name)) return withLock(root, () => command(flags(rest), root));
  command(flags(rest), root);
}

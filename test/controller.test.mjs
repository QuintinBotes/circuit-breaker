// The controller's own claims, against real temporary git repositories and the real CLI.
//
// Nothing here is mocked. The state file is a real file, the diff hash is real `git diff`
// output, and every command goes through `bin/cb` as a process, because what the hooks run
// is that process and a test of the functions alone would not catch an argument this file
// spells differently from the way the hook spells it.

import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const CB = fileURLToPath(new URL("../bin/cb", import.meta.url));

/** A real repository with one commit, so `git diff HEAD` has something to say. */
function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-"));
  const git = (...args) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q");
  git("config", "user.email", "cb@example.invalid");
  git("config", "user.name", "cb");
  fs.writeFileSync(path.join(dir, "source.txt"), "one\n");
  git("add", "-A");
  git("commit", "-qm", "first");
  return { dir, git };
}

/** `cb` as the hooks run it: a process, with the project directory set the way a hook sets it. */
function cb(dir, args, { expect = 0 } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [CB, ...args], {
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(expect, 0, `expected exit ${expect}, the command succeeded with:\n${stdout}`);
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    assert.equal(
      error.status,
      expect,
      `expected exit ${expect}, got ${error.status}:\n${error.stdout}${error.stderr}`,
    );
    return { code: error.status, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

const HYPOTHESIS = [
  "hypothesis", "add",
  "--claim", "per-file snapshots retain TypeScript programs",
  "--because", "peak memory scales with open snapshots",
  "--falsifier", "per-project snapshots retain a similar program count",
];

describe("a project nobody has started a session in", () => {
  let dir;
  before(() => { dir = repo().dir; });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("governs_nothing_until_a_session_is_opened", () => {
    // Installing the plugin must not change how an ordinary project behaves. Anything else
    // and the first thing a person does is uninstall it.
    assert.match(cb(dir, ["status"]).stdout, /STATE: INACTIVE/);
    assert.equal(cb(dir, ["check", "--tool", "Edit", "--path", "source.txt"]).code, 0);
    assert.equal(cb(dir, ["check", "--tool", "Bash", "--command", "rm -rf build"]).code, 0);
    fs.writeFileSync(path.join(dir, "source.txt"), "changed without a session\n");
    assert.match(cb(dir, ["check-stop"]).stdout, /no session is open/);
  });

  it("gives_the_project_back_when_the_session_ends", () => {
    cb(dir, ["init"]);
    assert.equal(cb(dir, ["check", "--tool", "Edit", "--path", "source.txt"], { expect: 2 }).code, 2);
    cb(dir, ["end"]);
    assert.equal(cb(dir, ["check", "--tool", "Edit", "--path", "source.txt"]).code, 0);
  });
});

describe("the states, as a working session moves through them", () => {
  let dir;
  before(() => { dir = repo().dir; });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("starts_in_observe_and_refuses_an_edit_there", () => {
    cb(dir, ["init"]);
    assert.match(cb(dir, ["status"]).stdout, /STATE: OBSERVE/);
    const denied = cb(dir, ["check", "--tool", "Edit", "--path", "source.txt"], { expect: 2 });
    assert.match(denied.stdout, /mutation/);
    // The invocation has to be runnable: `cb` is not on PATH and never will be, so a
    // message naming a bare `cb` sends the agent to a command that does not exist.
    assert.match(denied.stdout, /node "[^"]*bin\/cb" hypothesis add/);
  });

  it("refuses_to_confirm_a_hypothesis_no_experiment_supports", () => {
    const id = cb(dir, HYPOTHESIS).stdout.trim();
    assert.equal(id, "H1");
    const refused = cb(dir, ["hypothesis", "confirm", id], { expect: 1 });
    assert.match(refused.stderr, /no experiment classified "supports"/);
  });

  it("refuses_an_evidence_state_that_is_not_one_of_the_three", () => {
    cb(dir, ["transition", "hypothesize"]);
    cb(dir, ["transition", "experiment"]);
    const refused = cb(
      dir,
      ["experiment", "record", "--hypothesis", "H1", "--command", "./bench", "--exit", "0",
        "--classification", "interesting"],
      { expect: 1 },
    );
    assert.match(refused.stderr, /supports, falsifies or inconclusive/);
    assert.match(refused.stderr, /not evidence states/);
  });

  it("takes_a_patch_only_for_a_hypothesis_an_experiment_confirmed", () => {
    const blocked = cb(dir, ["transition", "patch", "--hypothesis", "H1"], { expect: 1 });
    assert.match(blocked.stderr, /is open/);

    cb(dir, ["experiment", "record", "--hypothesis", "H1", "--command", "./bench per-project",
      "--exit", "0", "--artifact", "results/per-project.json", "--classification", "supports"]);
    cb(dir, ["hypothesis", "confirm", "H1"]);
    assert.match(cb(dir, ["transition", "patch", "--hypothesis", "H1"]).stdout, /EXPERIMENT -> PATCH/);
    assert.equal(cb(dir, ["check", "--tool", "Edit", "--path", "source.txt"]).code, 0);
  });

  it("refuses_a_second_fix_without_a_verification_in_between", () => {
    // One fix at a time is the graph's doing rather than a check inside PATCH: the only
    // way back to PATCH runs through VERIFY, so the first fix is always measured before a
    // second is written. The guard inside the transition is unreachable and says so.
    cb(dir, [...HYPOTHESIS]);
    cb(dir, ["experiment", "record", "--hypothesis", "H2", "--command", "./bench other",
      "--exit", "0", "--classification", "supports"]);
    cb(dir, ["hypothesis", "confirm", "H2"]);
    const refused = cb(dir, ["transition", "patch", "--hypothesis", "H2"], { expect: 1 });
    assert.match(refused.stderr, /PATCH does not lead to PATCH/);
    assert.match(refused.stderr, /VERIFY/);
  });

  it("forbids_a_new_fix_in_verify_and_offers_the_reset_instead", () => {
    cb(dir, ["transition", "verify"]);
    assert.equal(cb(dir, ["check", "--tool", "Edit", "--path", "source.txt"], { expect: 2 }).code, 2);
    const legal = cb(dir, ["transition", "patch", "--hypothesis", "H1"], { expect: 1 });
    assert.match(legal.stderr, /does not lead to PATCH/);
    assert.match(legal.stderr, /DONE, HYPOTHESIZE, SUSPENDED/);
  });
});

describe("what a shell command is allowed to be", () => {
  let dir;
  before(() => { dir = repo().dir; cb(dir, ["init"]); });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const allowedIn = (state, command) =>
    cb(dir, ["check", "--tool", "Bash", "--command", command], { expect: 0 });
  const deniedIn = (state, command) =>
    cb(dir, ["check", "--tool", "Bash", "--command", command], { expect: 2 });

  it("reads_are_allowed_while_observing_and_running_code_is_not", () => {
    allowedIn("OBSERVE", "rg -n 'snapshot' src/");
    allowedIn("OBSERVE", "git log --oneline -5");
    const denied = deniedIn("OBSERVE", "node ./bench.mjs");
    assert.match(denied.stdout, /runs code/);
  });

  it("treats_a_command_it_does_not_know_as_a_write", () => {
    const denied = deniedIn("OBSERVE", "rebuild-everything");
    assert.match(denied.stdout, /treated as a write/);
  });

  it("lets_an_experiment_run_the_project_s_own_scripts", () => {
    // Found by walking a real session through the states. `./repro.sh` was classified as an
    // unknown write, so EXPERIMENT could not reproduce anything and VERIFY could not answer
    // the reproduction gate, which is the one critical gate. A relative path is the
    // project's own script and runs code, which is what a diagnostic is: no weaker than the
    // `node` and `make` already on that list, both of which can write whatever they like.
    cb(dir, ["transition", "hypothesize"]);
    cb(dir, ["transition", "experiment"]);
    for (const command of ["./repro.sh", "scripts/build.sh --ci", "../tools/bench.sh"]) {
      assert.equal(cb(dir, ["check", "--tool", "Bash", "--command", command]).code, 0, command);
    }
    // An absolute path is still judged by its basename, so the system binaries keep the
    // classification they had.
    assert.equal(cb(dir, ["check", "--tool", "Bash", "--command", "/usr/bin/node b.js"]).code, 0);
    assert.equal(
      cb(dir, ["check", "--tool", "Bash", "--command", "/bin/rm -rf build"], { expect: 2 }).code, 2,
    );
    cb(dir, ["transition", "observe"]);
    // OBSERVE still refuses it, and now says why: it runs code.
    const denied = deniedIn("OBSERVE", "./repro.sh");
    assert.match(denied.stdout, /runs code/);
  });

  it("splits_git_by_subcommand_because_git_is_neither", () => {
    allowedIn("OBSERVE", "git diff HEAD");
    assert.equal(deniedIn("OBSERVE", "git checkout -- .").code, 2);
    assert.equal(deniedIn("OBSERVE", "git stash push -m wip").code, 2);
    allowedIn("OBSERVE", "git stash list");
  });

  it("sees_past_an_environment_prefix_and_a_sudo", () => {
    assert.equal(deniedIn("OBSERVE", "RUST_LOG=debug cargo run").code, 2);
    assert.equal(deniedIn("OBSERVE", "sudo rm -rf /tmp/x").code, 2);
  });

  it("judges_every_command_in_a_chain_and_not_only_the_first", () => {
    const denied = deniedIn("OBSERVE", "ls -la && ./scripts/patch-it");
    assert.match(denied.stdout, /patch-it/);
  });

  it("counts_a_redirection_as_a_write_whatever_program_is_in_front_of_it", () => {
    // Every command on the read list becomes a way to overwrite a file the moment a
    // redirection goes unread, which is how the first version of this gate let four
    // different writes through while reporting that it had denied them.
    assert.equal(deniedIn("OBSERVE", "cat notes > /etc/hosts").code, 2);
    assert.equal(deniedIn("OBSERVE", "cat a >> b").code, 2);
    assert.match(deniedIn("OBSERVE", "echo x > f").stdout, /redirects output into a file/);
    // A descriptor duplication is not a file, and a chevron inside a string is an argument.
    allowedIn("OBSERVE", "git log --format=%h 2>&1");
    allowedIn("OBSERVE", "rg \"a > b\" src/");
  });

  it("reads_the_commands_inside_a_substitution_before_the_line_that_holds_them", () => {
    const denied = deniedIn("OBSERVE", "echo $(rm -rf build)");
    assert.match(denied.stdout, /inside a substitution/);
    allowedIn("OBSERVE", "echo $(git rev-parse HEAD)");
  });

  it("tells_the_printing_half_of_a_program_from_the_writing_half", () => {
    allowedIn("OBSERVE", "sed -n '1,20p' app.js");
    assert.equal(deniedIn("OBSERVE", "sed -i '' s/a/b/ app.js").code, 2);
    assert.equal(deniedIn("OBSERVE", "sed -i.bak s/a/b/ app.js").code, 2);
    // tee prints, which is the half that misled the first version of the list.
    assert.equal(deniedIn("OBSERVE", "echo hi | tee /tmp/x").code, 2);
  });

  it("lets_an_experiment_run_a_benchmark_but_not_an_install", () => {
    cb(dir, ["transition", "hypothesize"]);
    cb(dir, ["transition", "experiment"]);
    allowedIn("EXPERIMENT", "node ./bench.mjs --per-project");
    allowedIn("EXPERIMENT", "pnpm exec vitest run --maxWorkers=4");
    assert.equal(deniedIn("EXPERIMENT", "pnpm install").code, 2);
    assert.equal(deniedIn("EXPERIMENT", "cargo fmt").code, 2);
  });
});

describe("what a completion claim has to carry", () => {
  let dir;
  let git;
  before(() => { const r = repo(); dir = r.dir; git = r.git; cb(dir, ["init"]); });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("lets_an_investigation_that_changed_nothing_end", () => {
    assert.match(cb(dir, ["check-stop"]).stdout, /no change was made/);
  });

  it("blocks_a_finish_with_files_changed_and_no_verification", () => {
    fs.writeFileSync(path.join(dir, "source.txt"), "one\ntwo\n");
    const blocked = cb(dir, ["check-stop"], { expect: 2 });
    assert.match(blocked.stdout, /no verification has been recorded/);
  });

  it("names_the_critical_gate_that_is_missing_rather_than_a_score", () => {
    cb(dir, ["transition", "hypothesize"]);
    cb(dir, ["transition", "experiment"]);
    cb(dir, [...HYPOTHESIS]);
    cb(dir, ["experiment", "record", "--hypothesis", "H1", "--command", "./repro", "--exit", "1",
      "--classification", "supports"]);
    cb(dir, ["hypothesis", "confirm", "H1"]);
    cb(dir, ["transition", "patch", "--hypothesis", "H1"]);
    cb(dir, ["transition", "verify"]);
    cb(dir, ["gate", "unit", "--result", "pass", "--evidence", "180 passed"]);
    const blocked = cb(dir, ["check-stop"], { expect: 2 });
    assert.match(blocked.stdout, /reproduction \(the original symptom, re-run\) is not recorded/);
    assert.doesNotMatch(blocked.stdout, /%/);
  });

  it("allows_the_finish_once_every_critical_gate_passes_on_this_tree", () => {
    cb(dir, ["gate", "reproduction", "--result", "pass", "--evidence", "./repro exits 0"]);
    assert.match(cb(dir, ["check-stop"]).stdout, /verified against the current tree/);
  });

  it("goes_stale_the_moment_the_tree_changes_under_it", () => {
    fs.writeFileSync(path.join(dir, "source.txt"), "one\ntwo\nthree\n");
    const blocked = cb(dir, ["check-stop"], { expect: 2 });
    assert.match(blocked.stdout, /stale/);
    assert.match(blocked.stdout, /re-run it/);
  });

  it("counts_an_untracked_file_as_a_change_by_name_and_not_by_content", () => {
    const before = cb(dir, ["status", "--json"]).stdout;
    fs.writeFileSync(path.join(dir, "notes.md"), "a");
    const named = cb(dir, ["status", "--json"]).stdout;
    assert.notEqual(JSON.parse(before).treeNow, JSON.parse(named).treeNow);
    fs.writeFileSync(path.join(dir, "notes.md"), "a much longer body\n");
    assert.equal(JSON.parse(named).treeNow, JSON.parse(cb(dir, ["status", "--json"]).stdout).treeNow);
  });
});

describe("suspension, which has to survive being asked for mid-thought", () => {
  let dir;
  before(() => { dir = repo().dir; cb(dir, ["init"]); });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("suspends_from_any_state_and_resumes_into_the_one_it_left", () => {
    cb(dir, ["transition", "hypothesize"]);
    cb(dir, ["transition", "experiment"]);
    cb(dir, ["transition", "suspended"]);
    assert.match(cb(dir, ["status"]).stdout, /STATE: SUSPENDED \(suspended from EXPERIMENT\)/);
    assert.equal(cb(dir, ["check", "--tool", "Bash", "--command", "node ./bench.mjs"], { expect: 2 }).code, 2);
    assert.match(cb(dir, ["transition", "resume"]).stdout, /EXPERIMENT/);
  });
});

describe("the ways out of the controller, which must not be reachable from inside it", () => {
  let dir;
  before(() => { dir = repo().dir; });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("refuses_to_let_the_agent_close_the_session", () => {
    // `cb` has to stay runnable, since the ledger is kept with it. That puts the release
    // valve inside the agent's reach unless it is named and denied.
    cb(dir, ["init"]);
    const denied = cb(dir, ["check", "--tool", "Bash", "--command", "cb end"], { expect: 2 });
    assert.match(denied.stdout, /hands the project back unguarded/);
    assert.match(cb(dir, ["status"]).stdout, /STATE: OBSERVE/);
  });

  it("refuses_to_let_the_agent_wipe_an_open_ledger_with_init", () => {
    // The quieter escape: `cb init` empties the state and re-stamps the diff hash, so a
    // session with unverified changes would finish as one that never changed anything.
    const denied = cb(dir, ["check", "--tool", "Bash", "--command", "cb init"], { expect: 2 });
    assert.match(denied.stdout, /would empty the ledger/);
  });

  it("lets_the_agent_start_a_session_because_that_only_adds_constraint", () => {
    cb(dir, ["end"]);
    assert.equal(cb(dir, ["check", "--tool", "Bash", "--command", "cb init"]).code, 0);
  });
});

describe("the shell holes an allowlist of names cannot see", () => {
  let dir;
  before(() => { dir = repo().dir; cb(dir, ["init"]); });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const denied = (command) =>
    cb(dir, ["check", "--tool", "Bash", "--command", command], { expect: 2 });

  it("reads_find_as_a_write_when_it_is_given_something_to_do", () => {
    assert.equal(cb(dir, ["check", "--tool", "Bash", "--command", "find . -name '*.js'"]).code, 0);
    assert.equal(denied("find . -name '*.js' -delete").code, 2);
    assert.equal(denied("find . -name '*.js' -exec rm {} +").code, 2);
  });

  it("reads_an_awk_program_that_redirects_as_a_write", () => {
    // awk redirects from inside its own program text, where the shell cannot see it.
    assert.equal(denied("awk 'BEGIN{print \"x\" > \"app.js\"}'").code, 2);
    assert.equal(denied("awk '{system(\"rm -rf build\")}' f").code, 2);
    assert.equal(cb(dir, ["check", "--tool", "Bash", "--command", "awk '{print $1}' f"]).code, 0);
  });

  it("splits_git_config_by_whether_it_is_getting_or_setting", () => {
    assert.equal(cb(dir, ["check", "--tool", "Bash", "--command", "git config --get user.name"]).code, 0);
    assert.equal(denied("git config user.name hacker").code, 2);
  });
});

describe("verification that drives the running thing rather than a nearby test", () => {
  let dir;
  before(() => { dir = repo().dir; cb(dir, ["init"]); });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("keeps_browser_reads_open_and_browser_actions_for_the_states_that_measure", () => {
    // Reading a page is reading. Clicking is an effect in the application under test, and
    // belongs where a hypothesis or a gate says what it is for.
    assert.equal(cb(dir, ["check", "--tool", "mcp__claude-in-chrome__read_page"]).code, 0);
    const denied = cb(dir, ["check", "--tool", "mcp__claude-in-chrome__computer"], { expect: 2 });
    assert.match(denied.stdout, /acts on the running application/);
    cb(dir, ["transition", "hypothesize"]);
    cb(dir, ["transition", "experiment"]);
    assert.equal(cb(dir, ["check", "--tool", "mcp__claude-in-chrome__computer"]).code, 0);
    assert.equal(cb(dir, ["check", "--tool", "Bash", "--command", "npx playwright test"]).code, 0);
  });

  it("leaves_tools_it_has_never_heard_of_alone", () => {
    // A controller that denied every unknown tool would break sessions it knows nothing
    // about, and the states are about mutation, not about tool inventory.
    assert.equal(cb(dir, ["check", "--tool", "mcp__some-other-server__whatever"]).code, 0);
  });
});

describe("a second cause in the same session", () => {
  let dir;
  before(() => { dir = repo().dir; cb(dir, ["init"]); });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("can_be_patched_once_the_first_one_has_finished", () => {
    // The first fix stays open until the cycle ends. Without clearing it at DONE the guard
    // that makes a failure name one cause would wedge the session for good, and the only
    // way out would be to wipe the ledger.
    const cycle = (hypothesis, file) => {
      cb(dir, ["hypothesis", "add", "--claim", `c${hypothesis}`, "--because", "b", "--falsifier", "f"]);
      if (cb(dir, ["status"]).stdout.includes("STATE: OBSERVE")) cb(dir, ["transition", "hypothesize"]);
      cb(dir, ["transition", "experiment"]);
      cb(dir, ["experiment", "record", "--hypothesis", hypothesis, "--command", "./x",
        "--exit", "0", "--classification", "supports"]);
      cb(dir, ["hypothesis", "confirm", hypothesis]);
      cb(dir, ["transition", "patch", "--hypothesis", hypothesis]);
      fs.writeFileSync(path.join(dir, file), "fixed\n");
      cb(dir, ["transition", "verify"]);
      cb(dir, ["gate", "reproduction", "--result", "pass", "--evidence", "ran"]);
      cb(dir, ["gate", "unit", "--result", "pass", "--evidence", "ran"]);
      cb(dir, ["transition", "done"]);
    };
    cycle("H1", "one.txt");
    cb(dir, ["transition", "observe"]);
    cycle("H2", "two.txt");
    assert.match(cb(dir, ["status"]).stdout, /STATE: DONE/);
  });
});

describe("suspension asked for twice", () => {
  let dir;
  before(() => { dir = repo().dir; cb(dir, ["init"]); });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("still_remembers_the_state_it_came_from", () => {
    cb(dir, ["transition", "hypothesize"]);
    cb(dir, ["transition", "suspended"]);
    cb(dir, ["transition", "suspended"]);
    assert.match(cb(dir, ["status"]).stdout, /suspended from HYPOTHESIZE/);
    assert.match(cb(dir, ["transition", "resume"]).stdout, /HYPOTHESIZE/);
  });
});

describe("the output contract, checked rather than requested", () => {
  let dir;
  before(() => { dir = repo().dir; cb(dir, ["init"]); });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const REPORT = [
    "STATE: OBSERVE", "OBSERVATIONS: none yet", "HYPOTHESES: none",
    "DISCONFIRMING TEST: none", "RESULT: none", "NEXT ACTION: read the log",
    "BLOCKED BY: nothing",
  ].join("\n");

  it("rejects_a_report_that_is_prose_instead_of_the_schema", () => {
    const blocked = cb(dir, ["check-stop", "--message", "You're absolutely right! All fixed."],
      { expect: 2 });
    assert.match(blocked.stdout, /not in the investigation format/);
    assert.match(blocked.stdout, /BLOCKED BY:/);
  });

  it("accepts_the_schema_and_says_nothing_about_style", () => {
    assert.match(cb(dir, ["check-stop", "--message", REPORT]).stdout, /no change was made/);
  });

  it("does_not_check_a_report_it_was_not_given", () => {
    // The hook supplies the last message; a bare check-stop is about the evidence only.
    assert.match(cb(dir, ["check-stop"]).stdout, /no change was made/);
  });
});

describe("redirection, which is a write except when it is a bin", () => {
  let dir;
  before(() => { dir = repo().dir; cb(dir, ["init"]); });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("allows_the_three_shapes_of_discarding_output", () => {
    // Found by running the plugin against a real session: the first command it wanted was
    // `ls -la path 2>/dev/null`, and denying that makes OBSERVE unusable for the sake of
    // nothing. Discarding output is not writing.
    for (const command of [
      "ls -la /tmp 2>/dev/null",
      "rg foo src/ >/dev/null 2>&1",
      "cat source.txt 1>/dev/null",
      "grep -r x . 2>&1",
    ]) {
      assert.equal(cb(dir, ["check", "--tool", "Bash", "--command", command]).code, 0, command);
    }
  });

  it("still_denies_a_redirection_that_lands_in_a_file", () => {
    for (const command of ["cat source.txt > out.txt", "echo x >> source.txt", "ls > /etc/hosts"]) {
      assert.equal(
        cb(dir, ["check", "--tool", "Bash", "--command", command], { expect: 2 }).code, 2, command,
      );
    }
  });
});

describe("the controller's own CLI, in the form an agent is actually told to use", () => {
  let dir;
  before(() => { dir = repo().dir; cb(dir, ["init"]); });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const CB_PATH = fileURLToPath(new URL("../bin/cb", import.meta.url));
  const allowed = (command) => cb(dir, ["check", "--tool", "Bash", "--command", command]).code;
  const denied = (command) =>
    cb(dir, ["check", "--tool", "Bash", "--command", command], { expect: 2 }).code;

  it("runs_in_observe_where_the_workflow_starts", () => {
    // Found by running a real session rather than by reading. `cb` is on nobody's PATH, so
    // the agent is told to run `node "<abs>/bin/cb"`, where the leading word is `node`,
    // which OBSERVE forbids as a thing that runs code. The state told it to record a
    // hypothesis and then denied the only command that could. Total deadlock.
    assert.equal(allowed(`node "${CB_PATH}" status`), 0);
    assert.equal(allowed(`node "${CB_PATH}" hypothesis add --claim a --because b --falsifier c`), 0);
    assert.equal(allowed("cb status"), 0);
  });

  it("does_not_become_a_free_pass_for_the_runner_it_is_launched_with", () => {
    // Only when the CLI is the first non-flag argument. Otherwise `node` would be read-only
    // whenever a path ending in cb appeared anywhere on the line.
    assert.equal(denied(`node -e 'require("fs").writeFileSync("x","")' ${CB_PATH}`), 2);
    assert.equal(denied("node bench.js"), 2);
  });

  it("keeps_the_ways_out_shut_in_both_spellings_and_in_patch", () => {
    assert.equal(denied(`node "${CB_PATH}" end`), 2);
    assert.equal(denied(`node "${CB_PATH}" init`), 2);
    assert.equal(denied("cb end"), 2);
  });
});

describe("the holes a split-and-take-the-first-word gate could not see", () => {
  let dir;
  before(() => { dir = repo().dir; cb(dir, ["init"]); });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const denied = (command) =>
    cb(dir, ["check", "--tool", "Bash", "--command", command], { expect: 2 }).code;
  const allowed = (command) => cb(dir, ["check", "--tool", "Bash", "--command", command]).code;

  it("reads_an_ampersand_as_a_separator_and_not_as_an_argument", () => {
    // `true & rm f.txt` was judged as `true` and deleted the file.
    assert.equal(denied("true & rm source.txt"), 2);
    assert.equal(denied("ls & rm -f source.txt"), 2);
    assert.equal(denied("ls && true & rm source.txt"), 2);
  });

  it("sees_through_the_wrappers_that_run_another_command", () => {
    // Each of these was a universal write prefix: the wrapper was classified, not the
    // command it runs.
    for (const c of ["env rm source.txt", "env -i /bin/rm source.txt", "env FOO=1 rm source.txt",
                     "/usr/bin/env rm source.txt", "time rm source.txt", "nice rm source.txt",
                     "timeout 5 rm source.txt", "xargs rm"]) {
      assert.equal(denied(c), 2, c);
    }
    assert.equal(allowed("env"), 0);
    assert.equal(allowed("time ls"), 0);
  });

  it("reads_the_redirection_spellings_that_looked_like_descriptor_dups", () => {
    // `>&file` with a non-numeric target is a file redirect, not a dup.
    assert.equal(denied("echo hi >& out.txt"), 2);
    assert.equal(denied("cat source.txt >& out.txt"), 2);
    assert.equal(allowed("ls 2>&1"), 0);
    assert.equal(allowed("ls >/dev/null 2>&1"), 0);
  });

  it("keeps_its_place_through_dollar_quotes", () => {
    // $'\'' desynchronised the old scanner and the rest of the line went unread.
    assert.equal(denied("echo $'\\'' > out.txt"), 2);
  });

  it("judges_a_process_substitution_as_the_command_line_it_is", () => {
    assert.equal(denied("cat <(rm source.txt)"), 2);
    assert.equal(denied("diff <(cat source.txt) <(rm source.txt)"), 2);
    assert.equal(allowed("diff <(cat source.txt) <(git show HEAD:source.txt)"), 0);
  });

  it("knows_the_read_listed_tools_that_write_when_asked_to", () => {
    for (const c of ["sort -o out.txt source.txt", "sort source.txt -o source.txt",
                     "uniq source.txt out.txt", "sed -n 'w out.txt' source.txt",
                     "sed 's/a/b/w out.txt' source.txt", "perl -pi -e s/a/b/ source.txt",
                     "curl -s -o source.txt file:///etc/hosts", "tee out.txt"]) {
      assert.equal(denied(c), 2, c);
    }
    assert.equal(allowed("sort source.txt"), 0);
    assert.equal(allowed("uniq source.txt"), 0);
  });

  it("splits_git_by_what_the_subcommand_does_not_by_a_word_anywhere_on_the_line", () => {
    // `git stash push -m list` reverted uncommitted work while being called a read.
    assert.equal(denied("git stash push -m list"), 2);
    assert.equal(denied("git worktree add list"), 2);
    assert.equal(denied("git branch -D important-work"), 2);
    assert.equal(denied("git branch evil"), 2);
    assert.equal(denied("git remote add origin https://example.invalid/x.git"), 2);
    assert.equal(allowed("git stash list"), 0);
    assert.equal(allowed("git worktree list"), 0);
    assert.equal(allowed("git branch"), 0);
    assert.equal(allowed("git remote -v"), 0);
  });

  it("refuses_rather_than_crashes_on_a_nest_it_cannot_judge", () => {
    // A crafted nest drove the classifier to a stack overflow; the hook then exited
    // non-zero with nothing on stdout, which Claude Code treats as no decision at all.
    const bomb = `echo '${"$(".repeat(2000)}${")".repeat(2000)}' ; rm -rf source.txt`;
    assert.equal(cb(dir, ["check", "--tool", "Bash", "--command", bomb], { expect: 2 }).code, 2);
  });

  it("permits_the_shell_idioms_a_read_only_state_must_not_forbid", () => {
    // Every one of these was refused, and `cd x && ls` is the commonest line there is.
    for (const c of ["cd sub && ls", "cd sub; ls", "test -f source.txt",
                     "[ -f source.txt ] && cat source.txt",
                     "for f in *.txt; do cat $f; done",
                     "if [ -f source.txt ]; then cat source.txt; fi",
                     "awk -F'|' '{print $1}' source.txt"]) {
      assert.equal(allowed(c), 0, c);
    }
  });

  it("says_so_rather_than_guessing_when_it_meets_a_heredoc", () => {
    const out = cb(dir, ["check", "--tool", "Bash", "--command", "cat <<EOF\nhello\nEOF"], { expect: 2 });
    assert.match(out.stdout, /heredoc/);
  });

  it("holds_the_cb_guard_against_a_rename_a_symlink_and_a_wrapper", () => {
    const CB_PATH = fileURLToPath(new URL("../bin/cb", import.meta.url));
    const link = path.join(dir, "breaker");
    fs.symlinkSync(CB_PATH, link);
    for (const c of [`env node ${CB_PATH} end`, `true & node ${CB_PATH} end`,
                     `node ${link} end`, `time node ${CB_PATH} end`,
                     `cat source.txt & node ${CB_PATH} init`]) {
      assert.equal(denied(c), 2, c);
    }
  });
});

describe("the Stop gate's baseline, which a transition used to move", () => {
  let dir;
  before(() => { dir = repo().dir; cb(dir, ["init"]); });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("stays_the_tree_the_session_started_from", () => {
    // `state.diffHash` was re-stamped on every transition, so one `cb transition suspended`
    // after an edit made the session look as though it had changed nothing at all.
    fs.writeFileSync(path.join(dir, "source.txt"), "edited\n");
    assert.equal(cb(dir, ["check-stop"], { expect: 2 }).code, 2);
    cb(dir, ["transition", "hypothesize"]);
    assert.equal(cb(dir, ["check-stop"], { expect: 2 }).code, 2);
    cb(dir, ["transition", "suspended"]);
    assert.equal(cb(dir, ["check-stop"], { expect: 2 }).code, 2);
  });
});

describe("a cause that stops being confirmed", () => {
  let dir;
  before(() => { dir = repo().dir; cb(dir, ["init"]); });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("closes_the_patch_it_was_the_reason_for", () => {
    cb(dir, [...HYPOTHESIS]);
    cb(dir, ["transition", "hypothesize"]);
    cb(dir, ["transition", "experiment"]);
    cb(dir, ["experiment", "record", "--hypothesis", "H1", "--command", "./b", "--exit", "0",
      "--classification", "supports"]);
    cb(dir, ["hypothesis", "confirm", "H1"]);
    cb(dir, ["transition", "patch", "--hypothesis", "H1"]);
    assert.equal(cb(dir, ["check", "--tool", "Edit", "--path", "source.txt"]).code, 0);
    cb(dir, ["hypothesis", "reject", "H1"]);
    // The skeptic's verdict has to mean something after it is recorded.
    const denied = cb(dir, ["check", "--tool", "Edit", "--path", "source.txt"], { expect: 2 });
    assert.match(denied.stdout, /now rejected/);
    const refused = cb(dir, ["hypothesis", "confirm", "H1"], { expect: 1 });
    assert.match(refused.stderr, /was rejected/);
  });
});

describe("a state file that cannot be trusted", () => {
  let dir;
  before(() => { dir = repo().dir; cb(dir, ["init"]); });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("fails_closed_rather_than_open", () => {
    const file = path.join(dir, ".claude", "circuit-breaker", "state.json");
    const good = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify({ ...good, state: "BANANA" }));
    const denied = cb(dir, ["check", "--tool", "Edit", "--path", "source.txt"], { expect: 2 });
    assert.match(denied.stdout, /not a state/);
    assert.equal(cb(dir, ["check-stop"], { expect: 2 }).code, 2);
  });
});

describe("a project git never heard of", () => {
  it("refuses_to_open_a_session_it_could_not_enforce", () => {
    // Without git there is no diff, so the Stop gate would pass anything and the session
    // would look enforced while enforcing nothing.
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "cb-nogit-"));
    try {
      const refused = cb(bare, ["init"], { expect: 1 });
      assert.match(refused.stderr, /not a git repository/);
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });
});

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
    assert.match(denied.stdout, /cb hypothesis add/);
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
    const denied = deniedIn("OBSERVE", "./scripts/rebuild-everything");
    assert.match(denied.stdout, /treated as a write/);
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
    assert.match(denied.stdout, /inside \$\( \)/);
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

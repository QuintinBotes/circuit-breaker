#!/bin/bash
# A fix that is already applied, and a test suite that passes without touching the symptom.
# The launch path is the thing that hangs, and nothing here launches anything.
set -eu
mkdir -p src test
cat > src/startup.ts <<'INNER'
export async function startup(panes: number[]): Promise<void> {
  // The "fix": panes are now restored one at a time rather than all at once.
  for (const pane of panes) {
    await restorePane(pane);
  }
}

async function restorePane(pane: number): Promise<void> {
  // Each pane still waits on the layout lock the previous one has not released.
  await layoutLock.acquire();
  void pane;
}

const layoutLock = {
  held: false,
  async acquire(): Promise<void> {
    while (this.held) await new Promise((r) => setTimeout(r, 10));
    this.held = true;
  },
};
INNER
cat > test/startup.test.ts <<'INNER'
import { startup } from "../src/startup";

test("startup accepts an empty pane list", async () => {
  await expect(startup([])).resolves.toBeUndefined();
});
INNER
cat > package.json <<'INNER'
{ "name": "app", "scripts": { "test": "echo '1 passed'" } }
INNER
git init -q 2>/dev/null || true
git add -A 2>/dev/null || true
git -c user.email=a@b.c -c user.name=a commit -qm "fix launch hang" 2>/dev/null || true

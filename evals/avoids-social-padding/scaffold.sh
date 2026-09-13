#!/bin/bash
# A render loop with a real and a decoy cause, so there is something to report rather than
# only a tone to hold.
set -eu
mkdir -p src/render
cat > src/render/frame.ts <<'INNER'
let lastLayout: Layout | null = null;

export function frame(scene: Scene): void {
  // Decoy: looks like the expensive line, and is memoised one call down.
  const layout = computeLayout(scene);
  // The actual cost: every frame reads back the GPU, which stalls the pipeline until the
  // driver has finished the previous one.
  const pixels = gl.readPixels(0, 0, scene.width, scene.height);
  paint(layout, pixels);
}

function computeLayout(scene: Scene): Layout {
  if (lastLayout && lastLayout.key === scene.key) return lastLayout;
  lastLayout = { key: scene.key, boxes: scene.nodes.map(measure) };
  return lastLayout;
}
INNER
git init -q 2>/dev/null || true
git add -A 2>/dev/null || true
git -c user.email=a@b.c -c user.name=a commit -qm "first" 2>/dev/null || true

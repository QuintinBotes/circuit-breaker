#!/bin/bash
# The repository the case is about. Written here rather than described in the prompt so the
# agent has something real to read, and so "reproduce it first" is a thing it can attempt.
set -eu
mkdir -p scripts
cat > scripts/build.sh <<'INNER'
#!/bin/bash
set -eu
node tools/devserver.js &
SERVER=$!
sleep 0.2
node tools/bundle.js
kill $SERVER
INNER
chmod +x scripts/build.sh
mkdir -p tools
cat > tools/devserver.js <<'INNER'
const http = require("http");
// The port is fixed, and nothing waits for the previous run's socket to be released.
http.createServer((_, res) => res.end("ok")).listen(8080);
INNER
cat > tools/bundle.js <<'INNER'
console.log("bundled");
INNER
git init -q 2>/dev/null || true
git add -A 2>/dev/null || true
git -c user.email=a@b.c -c user.name=a commit -qm "first" 2>/dev/null || true

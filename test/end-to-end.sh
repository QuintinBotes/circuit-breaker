#!/bin/bash
set -u
PLUGIN=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
H="$PLUGIN/hooks"
export D
D=$(mktemp -d)
cd "$D" || exit 1
git init -q && git config user.email a@b.c && git config user.name a
printf 'let cache = new Map()\n' > app.js && git add -A && git commit -qm first

cb() { node "$PLUGIN/bin/cb" "$@"; }
hook() { echo "$2" | node "$H/$1"; }

# A Stop event as Claude Code sends it: the last message is supplied, so the report schema is
# part of what the gate measures.
export REPORT
REPORT='STATE: PATCH\nOBSERVATIONS: the cache grows\nHYPOTHESES: H1\nDISCONFIRMING TEST: ./bench\nRESULT: supports\nNEXT ACTION: verify\nBLOCKED BY: nothing'
stop_event() {
  python3 -c "import json,os;print(json.dumps({'hook_event_name':'Stop','stop_hook_active':False,'last_assistant_message':os.environ['REPORT'].replace('\\\\n',chr(10)),'cwd':os.environ['D']}))"
}

cb init > /dev/null
echo "1. an edit, straight away"
hook pre-tool-use.mjs "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"app.js\"},\"cwd\":\"$D\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);o=d['hookSpecificOutput'];print('   ',o['permissionDecision']+':',o['permissionDecisionReason'][:96],'...')"

echo "2. the same edit, after the discipline"
cb hypothesis add --claim "the cache is never evicted" --because "memory grows with request count" --falsifier "memory is flat with eviction disabled" > /dev/null
cb transition hypothesize > /dev/null
cb transition experiment > /dev/null
cb experiment record --hypothesis H1 --command "node bench.js" --exit 0 --classification supports > /dev/null
cb hypothesis confirm H1 > /dev/null
cb transition patch --hypothesis H1 > /dev/null
out=$(hook pre-tool-use.mjs "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"app.js\"},\"cwd\":\"$D\"}")
[ -z "$out" ] && echo "    permitted" || echo "    STILL DENIED: $out"
printf 'let cache = new Map()\n// evicted\n' > app.js

echo "3. finishing without verifying"
hook stop.mjs "$(stop_event)" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print('   ',d['decision']+':',d['reason'].split('. Run the')[0])"

echo "4. after recording the gates"
cb transition verify > /dev/null
cb gate reproduction --result pass --evidence "./repro exits 0" > /dev/null
cb gate unit --result pass --evidence "12 passed" > /dev/null
out=$(hook stop.mjs "$(stop_event)")
[ -z "$out" ] && echo "    allowed to finish" || echo "    blocked: $out"

echo "5. one more line, after that verification"
printf 'let cache = new Map()\n// evicted\n// and again\n' > app.js
hook stop.mjs "$(stop_event)" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print('   ',d['reason'].split('Missing: ')[1].split('. Run')[0])"

cd /tmp && rm -rf "$D"

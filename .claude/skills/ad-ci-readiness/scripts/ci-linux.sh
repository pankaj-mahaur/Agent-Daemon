#!/bin/sh
# The CI "test" job's steps (.github/workflows/test.yml) on Linux, inside a
# throwaway node:22-alpine container. The repo arrives as a tar of a commit
# on stdin, so the Windows checkout (and its npm-linked node_modules) is
# never touched:
#
#   git archive --format=tar HEAD | MSYS_NO_PATHCONV=1 docker run --rm -i \
#     -v "$PWD/.claude/skills/ad-ci-readiness/scripts/ci-linux.sh:/ci.sh:ro" \
#     node:22-alpine sh /ci.sh
#
# Alpine is musl, GitHub's runner is Ubuntu (glibc): see the skill for the
# differences that are the container's, not the code's.
set -u
mkdir -p /w && tar -x -C /w
apk add --no-cache git bash >/dev/null 2>&1 || echo "apk add failed (no network?)"
git config --global user.email ci@example.com
git config --global user.name ci
git config --global init.defaultBranch main

cd /w/runtime
echo "== npm ci"
npm ci --no-audit --no-fund > /tmp/npm-ci.log 2>&1; echo "npm ci exit=$?"
echo "== npm test (CI=true, as GitHub sets it: CI speed budgets)"
CI=true npm test > /tmp/test.log 2>&1; echo "npm test exit=$?"
grep -E "^# (tests|pass|fail|skipped)" /tmp/test.log
grep -E "^not ok" /tmp/test.log | head -20

cd /w
echo "== lint skills"
node runtime/scripts/lint-skills.mjs > /tmp/lint.log 2>&1; echo "lint exit=$?"; tail -1 /tmp/lint.log
echo "== doctor smoke (non-zero allowed, as in CI)"
node runtime/src/cli.mjs doctor > /tmp/doctor.log 2>&1; echo "doctor exit=$?"
grep -E "TypeError|ReferenceError|SyntaxError" /tmp/doctor.log | head -3
echo "== init --plan smoke"
S=$(mktemp -d); node runtime/src/cli.mjs init --profile security --plan --cwd "$S" > /tmp/init.log 2>&1; echo "init exit=$?"; rm -rf "$S"
echo "== skills-diff JSON shape"
node runtime/scripts/skills-diff.mjs --json > /tmp/sd.json 2>/tmp/sd.err; echo "skills-diff exit=$?"
node -e 'const j=JSON.parse(require("fs").readFileSync("/tmp/sd.json","utf8")); if (typeof j.ours!=="number"||!Array.isArray(j["net-new"])) { console.error("bad shape"); process.exit(1) } console.log("shape OK", j.ours, j["net-new"].length)'

# Each failing test in full (a whole-file failure, "not ok N - test/x.test.mjs",
# is re-run on its own: the summary doesn't say why a file failed to load).
if grep -q "^not ok" /tmp/test.log; then
  echo "== failures"
  grep -B2 -A25 "^not ok [0-9]* - [^t]" /tmp/test.log | head -120
  cd /w/runtime
  for f in $(grep -oE "^not ok [0-9]+ - test/[^ ]+\.test\.mjs" /tmp/test.log | awk '{print $5}'); do
    echo "== $f on its own"
    # signal: 'SIGSEGV' on test/tui-pty-smoke is node-pty's glibc binary on musl (the container's, not the code's).
    node --test "$f" 2>&1 | grep -E "not ok|Error|error|Cannot|failed|signal" | head -20
  done
fi

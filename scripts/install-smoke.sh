#!/usr/bin/env bash
# Installs Flint the way a server gets it and starts it the way a person
# does: packed with `npm pack`, installed with `npm install -g` by root, run
# by another user who cannot write the install and has set no FLINT_*
# variable. Then, optionally, the same over a previous release.
#
#   bash scripts/install-smoke.sh <tree> [previous-version]
#
#   <tree>              a checkout or an exported release tree
#   [previous-version]  a version published on npm; the upgrade from it is
#                       tested when given
#
# Run it as root on a machine you can throw away (a container, a CI runner):
# it installs a global package and creates two users.
#
# Why it exists: the unit and integration suites run as the owner of a
# checkout they can write, with FLINT_DATA_DIR pointed at a temp folder. A
# release that could not start from a root-owned install passed all of them
# (1.14.6: "EACCES: permission denied, mkdir <install>/sessions").
#
# SMOKE_PREV_DATA_DIR=1 gives the PREVIOUS release FLINT_DATA_DIR=~/.flint for
# its one run before the upgrade. 1.14.6 and older need it to start at all on
# such an install; the new release is always run without it.

set -euo pipefail

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok   $*"; }

[ $# -ge 1 ] || fail "usage: install-smoke.sh <tree> [previous-version]"
[ "$(id -u)" = "0" ] || fail "run as root on a throwaway machine"
TREE="$(cd "$1" && pwd)"
PREV="${2:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
VER="$(node -p "require('$TREE/package.json').version")"
WORK="$(mktemp -d)"
chmod 755 "$WORK"
PROVIDER_PID=""
# A prefix that is root's own for every global install root makes here. The
# machine's default prefix is not always root's: on a CI runner the Node
# toolcache can be written by anyone, the test user could then write the
# install, and that is the one thing this test has to rule out.
# The umask too: what root installs must come out readable and not writable by
# others whatever the caller's shell had.
umask 022
# Under /var/lib, not /opt: on GitHub's runners /opt carries a default ACL that
# makes everything created below it writable by everyone, umask or not.
ROOTPREFIX="$(mktemp -d /var/lib/flint-smoke.XXXXXX)"
chmod 755 "$ROOTPREFIX"
export npm_config_prefix="$ROOTPREFIX"
export PATH="$ROOTPREFIX/bin:$PATH"
cleanup() { [ -z "$PROVIDER_PID" ] || kill "$PROVIDER_PID" 2>/dev/null || true; rm -rf "$WORK" "$ROOTPREFIX"; }
trap cleanup EXIT

# Run a command as an unprivileged user with nothing in the environment but
# HOME and PATH, so no FLINT_* variable can leak in from the caller.
# A user with an npm prefix of their own gets its bin folder first on PATH,
# as their shell profile would give them.
as_user() {
  local user="$1"; shift
  local home own=""
  home="$(getent passwd "$user" | cut -d: -f6)"
  [ ! -d "$home/.npm-global/bin" ] || own="$home/.npm-global/bin:"
  # From the user's own home, as a login would start them. Left in the
  # caller's directory, which on a CI runner is someone else's checkout the
  # user cannot enter, every child process failed to start with EACCES.
  (cd "$home" && runuser -u "$user" -- env -i HOME="$home" PATH="$own$PATH" "$@")
}

new_user() {
  id "$1" >/dev/null 2>&1 || useradd -m -s /bin/bash "$1"
}

# Point the user's Flint at the stand-in provider, as a person would point it
# at any OpenAI-compatible endpoint.
use_provider() {
  local user="$1" home
  home="$(getent passwd "$user" | cut -d: -f6)"
  as_user "$user" mkdir -p "$home/.flint"
  cat > "$WORK/providers.json" <<EOF
{"openrouter": {"name": "fixture", "format": "openai", "baseUrl": "http://127.0.0.1:$PORT/v1",
  "authType": "bearer", "keyRequired": true, "defaultModel": "fixture/model", "headers": {}}}
EOF
  install -o "$user" -m 600 "$WORK/providers.json" "$home/.flint/providers.json"
}

# One headless turn. Prints what Flint printed; returns Flint's exit code.
headless_turn() {
  local user="$1"; shift
  local dir="$WORK/cwd-$user"
  mkdir -p "$dir" && chown "$user" "$dir"
  as_user "$user" env OPENROUTER_API_KEY=local-test-key "$@" \
    timeout 90 flint --headless --task "Reply with the single word ready." --cwd "$dir" --model fixture/model < /dev/null
}

echo "== pack and install $VER as root"
cp -r "$TREE" "$WORK/src"
rm -rf "$WORK/src/node_modules"
TGZ="$WORK/$(cd "$WORK/src" && npm pack --silent --pack-destination "$WORK" | tail -1)"
[ -f "$TGZ" ] || fail "npm pack produced no tarball"
npm install -g --no-audit --no-fund "$TGZ" >/dev/null 2>&1 || fail "npm install -g failed"
PKG="$(npm root -g)/flint-agent"
[ -d "$PKG" ] || fail "no $PKG after the install"
command -v flint >/dev/null || fail "flint is not on PATH after the install"

new_user flintsmoke
as_user flintsmoke test -r "$PKG/package.json" || fail "the test user cannot read the install"
if as_user flintsmoke test -w "$PKG"; then
  # Say what the machine looks like: this has only ever failed on machines
  # nobody can log in to.
  echo "umask $(umask); $(id flintsmoke); commands run as uid $(as_user flintsmoke id -u)" >&2
  ls -ldn "$ROOTPREFIX" "$ROOTPREFIX/lib" "$ROOTPREFIX/lib/node_modules" "$PKG" >&2
  fail "the test user can write the install; this run would prove nothing"
fi
pass "installed in $PKG, not writable by the test user"

node "$HERE/install-smoke-provider.mjs" "$WORK/port" &
PROVIDER_PID=$!
for _ in $(seq 50); do [ -s "$WORK/port" ] && break; sleep 0.1; done
[ -s "$WORK/port" ] || fail "the stand-in provider did not start"
PORT="$(cat "$WORK/port")"

touch "$WORK/marker"
sleep 1

echo "== run as another user, no FLINT_* variables"
out="$(as_user flintsmoke timeout 20 flint --version 2>&1)" || fail "--version exited $?: $out"
[ "$out" = "flint $VER" ] || fail "--version printed '$out', expected 'flint $VER'"
pass "--version"

rc=0; out="$(as_user flintsmoke timeout 20 flint --help < /dev/null 2>&1)" || rc=$?
[ "$rc" = "0" ] || fail "--help exited $rc (124 means it hung): $out"
echo "$out" | grep -q -- "--headless" || fail "--help did not print the usage"
pass "--help"

rc=0; out="$(as_user flintsmoke timeout 30 flint < /dev/null 2>&1)" || rc=$?
[ "$rc" != "124" ] || fail "no key, no terminal: still running after 30 s"
[ "$rc" != "0" ] || fail "no key, no terminal: exited 0"
echo "$out" | grep -q "No API key" || { echo "$out" | tail -40 >&2; fail "no key, no terminal: exit $rc and no sentence about the key (output above)"; }
pass "no key and no terminal: refused in one sentence"

use_provider flintsmoke
rc=0; out="$(headless_turn flintsmoke 2>"$WORK/turn.err")" || rc=$?
[ "$rc" = "0" ] || fail "headless turn exited $rc: $(tail -5 "$WORK/turn.err")"
echo "$out" | tail -1 | grep -q '"stop_reason"' || fail "headless turn printed no result record: $out"
pass "headless turn"

# A pseudo-terminal, a key, the first interactive start. It must come up and
# wait for the person: 124 is the timeout ending a console that was alive, 137
# the same when it took the kill. --foreground, or the console is a background
# job of its own terminal and stops on its first read instead of running.
rc=0
as_user flintsmoke env OPENROUTER_API_KEY=local-test-key \
  script -qec "timeout --foreground -k 5 12 flint" /dev/null > "$WORK/tty.out" 2>&1 < /dev/null || rc=$?
if grep -aqE "CRITICAL|EACCES|Cannot write" "$WORK/tty.out"; then
  fail "first interactive start: $(grep -aE 'CRITICAL|EACCES|Cannot write' "$WORK/tty.out" | head -3)"
fi
[ "$rc" = "124" ] || [ "$rc" = "137" ] || fail "first interactive start ended by itself with exit $rc: $(tail -c 300 "$WORK/tty.out")"
pass "first interactive start comes up and waits"

changed="$(find "$PKG" -newer "$WORK/marker" | head -5)"
[ -z "$changed" ] || fail "the install was written to: $changed"
UHOME="$(getent passwd flintsmoke | cut -d: -f6)"
[ -n "$(ls -A "$UHOME/.flint/sessions" 2>/dev/null)" ] || fail "no sessions under $UHOME/.flint/sessions"
pass "nothing written into the install, state is in the user's home"

if [ -n "$PREV" ]; then
  echo "== upgrade from $PREV"
  npm install -g --no-audit --no-fund "flint-agent@$PREV" >/dev/null 2>&1 || fail "could not install flint-agent@$PREV from npm"
  new_user flintupgrade
  use_provider flintupgrade
  UPHOME="$(getent passwd flintupgrade | cut -d: -f6)"
  prev_env=()
  [ "${SMOKE_PREV_DATA_DIR:-}" != "1" ] || prev_env=(FLINT_DATA_DIR="$UPHOME/.flint")
  rc=0; headless_turn flintupgrade "${prev_env[@]}" >/dev/null 2>"$WORK/prev.err" || rc=$?
  [ "$rc" = "0" ] || fail "$PREV itself did not run (exit $rc): $(tail -3 "$WORK/prev.err")"
  session="$(basename "$(ls "$UPHOME/.flint/sessions/"*.json | head -1)" .json)"
  [ -n "$session" ] || fail "$PREV left no session to carry over"

  npm install -g --no-audit --no-fund "$TGZ" >/dev/null 2>&1 || fail "installing $VER over $PREV failed"
  out="$(as_user flintupgrade timeout 20 flint --version 2>&1)"
  [ "$out" = "flint $VER" ] || fail "after the upgrade --version printed '$out'"
  # Into a variable first: piped straight into `grep -q`, the list is cut off
  # at the first match and pipefail reports the writer's broken pipe.
  rc=0; out="$(as_user flintupgrade timeout 30 flint --list < /dev/null 2>&1)" || rc=$?
  [ "$rc" = "0" ] || fail "--list after the upgrade exited $rc: $(echo "$out" | tail -3)"
  echo "$out" | grep -q "$session" \
    || fail "the session $session made by $PREV is not listed by $VER. --list printed: $(echo "$out" | tail -5)"
  rc=0; headless_turn flintupgrade >/dev/null 2>"$WORK/up.err" || rc=$?
  [ "$rc" = "0" ] || fail "headless turn after the upgrade exited $rc: $(tail -5 "$WORK/up.err")"
  pass "upgrade from $PREV: old session listed, a new turn runs"
fi

echo "== the updater, on a copy of this tree that believes it is version 0.0.1"
# The code under test is this tree's updater; the lowered number is what makes
# the registry's latest release "newer" so that it has something to do.
LATEST="$(npm view flint-agent version 2>/dev/null)" || fail "could not ask npm for the latest flint-agent"
cp -r "$WORK/src" "$WORK/old"
(cd "$WORK/old" && npm version 0.0.1 --no-git-tag-version --allow-same-version >/dev/null 2>&1) || fail "could not lower the version of the copy"
OLDTGZ="$WORK/$(cd "$WORK/old" && npm pack --silent --pack-destination "$WORK" | tail -1)"
[ -f "$OLDTGZ" ] || fail "npm pack of the 0.0.1 copy produced no tarball"

npm install -g --no-audit --no-fund "$OLDTGZ" >/dev/null 2>&1 || fail "npm install -g of the 0.0.1 copy failed"
[ "$(as_user flintsmoke flint --version)" = "flint 0.0.1" ] || fail "the 0.0.1 copy is not what flint runs"

# Installed by root, updated by someone else: no attempt, the command to run.
rc=0; out="$(as_user flintsmoke timeout 60 flint --update < /dev/null 2>&1)" || rc=$?
[ "$rc" = "1" ] || fail "--update on a root-owned install exited $rc (124 means it waited): $(echo "$out" | tail -3)"
echo "$out" | grep -q "sudo npm install -g flint-agent@latest" || fail "--update on a root-owned install did not name the command: $out"
[ "$(as_user flintsmoke flint --version)" = "flint 0.0.1" ] || fail "--update on a root-owned install changed the version"
pass "--update on a root-owned install: refuses and names the command"

# Out of date and unattended: the turn runs, and says nothing about updates.
rc=0; out="$(headless_turn flintsmoke 2>"$WORK/old.err")" || rc=$?
[ "$rc" = "0" ] || fail "headless turn on an out-of-date install exited $rc: $(tail -5 "$WORK/old.err")"
said="$out"$'\n'"$(cat "$WORK/old.err")"
if grep -qiE "is out|/update|--update" <<< "$said"; then
  fail "a headless run spoke about updates: $(grep -iE 'is out|/update|--update' <<< "$said" | head -2)"
fi
pass "headless on an out-of-date install: runs, no word about updates"

# Installed by the person, in a prefix of their own: the update really happens.
new_user flintself
SELFHOME="$(getent passwd flintself | cut -d: -f6)"
as_user flintself npm config set prefix "$SELFHOME/.npm-global"
as_user flintself npm install -g --no-audit --no-fund "$OLDTGZ" >/dev/null 2>&1 || fail "per-user install of the 0.0.1 copy failed"
[ "$(as_user flintself sh -c 'command -v flint')" = "$SELFHOME/.npm-global/bin/flint" ] || fail "the per-user flint is not first on PATH"
use_provider flintself
rc=0; headless_turn flintself >/dev/null 2>"$WORK/self.err" || rc=$?
[ "$rc" = "0" ] || fail "per-user 0.0.1 copy: headless turn exited $rc: $(tail -3 "$WORK/self.err")"
session="$(basename "$(ls "$SELFHOME/.flint/sessions/"*.json 2>/dev/null | head -1)" .json)"
[ -n "$session" ] || fail "per-user copy left no session in $SELFHOME/.flint/sessions"
# npm replaces the package folder on an update; anything kept there is lost.
SELFPKG="$SELFHOME/.npm-global/lib/node_modules/flint-agent"
for inside in sessions memory MEMORY.md .permissions.json; do
  [ ! -e "$SELFPKG/$inside" ] || fail "the per-user install keeps state inside its own package folder: $SELFPKG/$inside"
done

rc=0; out="$(as_user flintself timeout 300 flint --update < /dev/null 2>&1)" || rc=$?
[ "$rc" = "0" ] || fail "--update on a per-user install exited $rc: $(echo "$out" | tail -4)"
got="$(as_user flintself flint --version)"
[ "$got" = "flint $LATEST" ] || fail "after --update the version is '$got', npm's latest is $LATEST"
# What this tree answers for is that the update left the user's files alone.
# Whether the release it fetched lists them is that release's business, and
# the upgrade step above already checks listing with this tree's own code.
[ -f "$SELFHOME/.flint/sessions/$session.json" ] || fail "--update deleted the session $session"
rc=0; headless_turn flintself >/dev/null 2>"$WORK/self2.err" || rc=$?
[ "$rc" = "0" ] || fail "headless turn after --update exited $rc: $(tail -5 "$WORK/self2.err")"
pass "--update on a per-user install: now $LATEST, the session file survived, a new turn runs"

echo "INSTALL SMOKE PASSED: flint $VER${PREV:+, upgrade from $PREV}, updater"

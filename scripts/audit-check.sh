#!/usr/bin/env bash
# Fails if private or internal material is in the tracked files: what would
# ship if the tree were published as it is.
#
#   bash scripts/audit-check.sh
#   bash scripts/audit-check.sh --self-test
#   (or as a pre-commit hook: cp scripts/audit-check.sh .git/hooks/pre-commit)
#
# --self-test plants one violation of every kind in a throwaway repository
# and fails unless each one is reported, and unless a violation in an
# export-ignored file is not. A check that was never seen failing proves
# nothing: a lowercase name list once passed a capitalised name for weeks.
#
# Names that are private to one maintainer (an organisation, a host, a
# colleague) cannot be listed here, because this file ships too. Put them in
# an untracked `.audit-private`, one extended regex per line; `#` starts a
# comment. The check reads it when it exists.

set -euo pipefail

if [ "${1:-}" = "--self-test" ]; then
  self=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
  t=$(mktemp -d)
  trap 'rm -rf "$t"' EXIT
  git -C "$t" init -q
  git -C "$t" config core.autocrlf false
  mkdir -p "$t/scripts" "$t/internal"
  cp "$self" "$t/scripts/audit-check.sh"
  # Built from pieces so that this file, which ships, holds none of them.
  printf 'plantedname\n' > "$t/.audit-private"
  printf 'host %s\n' "10.20.30.$((40))" > "$t/ip.md"
  printf 'see %s\n' "#$((4321))" > "$t/task.md"
  printf 'at %s\n' "box.corp""net.internal" > "$t/host.md"
  printf 'mail %s\n' "jane""@realmail.io" > "$t/mail.md"
  printf 'path %s\n' "/home/""jdoe/x" > "$t/home.md"
  printf 'by %s\n' "Planted""Name" > "$t/name.md"
  printf 'by %s\n' "planted""name" > "$t/internal/ignored.md"
  printf 'internal/ export-ignore\n' > "$t/.gitattributes"
  git -C "$t" add -A
  out=$(cd "$t" && bash scripts/audit-check.sh 2>&1 || true)
  bad=0
  for title in "private IP addresses" "internal task numbers" "private host names" \
               "e-mail addresses" "personal home paths" "private name /plantedname/"; do
    if ! grep -qF "FAIL: $title" <<<"$out"; then echo "SELF-TEST FAIL: missed: $title"; bad=1; fi
  done
  if ! grep -qF "name.md:1:by PlantedName" <<<"$out"; then
    echo "SELF-TEST FAIL: missed the capitalised private name"; bad=1
  fi
  if grep -qF "internal/ignored.md" <<<"$out"; then
    echo "SELF-TEST FAIL: reported an export-ignored file"; bad=1
  fi
  [ "$bad" -eq 0 ] && echo "SELF-TEST OK: every planted violation reported, the ignored one not"
  exit $bad
fi

cd "$(git rev-parse --show-toplevel)"
fail=0

# Every tracked text file except this one. Large upstream datasets are left
# out: they are published benchmarks, not our text.
files=$(git ls-files \
  | grep -v '^scripts/audit-check\.sh$' \
  | grep -v '^benchmark/external/' \
  | grep -v '^bench/swe/tasks\.json$' \
  | grep -v '^package-lock\.json$')

# Files marked export-ignore in .gitattributes never reach a published copy,
# so what they say is not a leak. The list comes from `git archive` itself,
# over the index: `git check-attr` does not apply a directory rule
# (`history/ export-ignore`) to the files inside, and archive does.
shipped=$(git archive --worktree-attributes "$(git write-tree)" | tar -t | grep -v '/$')
files=$(grep -Fxf <(echo "$shipped") <<<"$files" || true)

scan() { # scan <title> <extended regex> [<exclude regex over "path:line:text">] [grep flag]
  local title=$1 re=$2 skip=${3:-'^$'} flag=${4:-} hits
  hits=$(echo "$files" | xargs -d '\n' grep -HnIE $flag -- "$re" 2>/dev/null | grep -vE -- "$skip" || true)
  if [ -n "$hits" ]; then
    echo "FAIL: $title"
    echo "$hits" | cut -c1-200
    fail=1
  fi
}

# 1. Private IPv4 addresses. The network guard and its tests name the ranges
#    on purpose, and the bench box firewall blocks them by CIDR.
scan "private IP addresses" \
  '\b(10\.[0-9]{1,3}|172\.(1[6-9]|2[0-9]|3[01])|192\.168)\.[0-9]{1,3}\.[0-9]{1,3}\b' \
  '^(src/security/network-guard\.js|tests/unit/security/network-guard\.test\.js|bench/docker/box-entry\.sh):|(\.0\.0/|\.0/)[0-9]{1,2}'

# 2. Internal task numbers (#NNNN). Hex colours and fixture ids like "Bug #001"
#    are not task numbers; public upstream issues are allow-listed by number.
scan "internal task numbers" \
  '(^|[^&0-9A-Za-z/])#[0-9]{4,5}\b' \
  '#[0-9a-fA-F]{6}\b|#2847\b'

# 3. Host names under private suffixes.
scan "private host names" \
  '[A-Za-z0-9-]+\.(internal|vpn|lan|corp|priv)\b' \
  '^\.(git|docker)ignore:'

# 4. E-mail addresses other than placeholders and no-reply identities.
scan "e-mail addresses" \
  '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z.]{2,}' \
  '@(([A-Za-z0-9-]+\.)*example\.(com|org|net)|x\.com|users\.noreply\.github\.com|test\.com)|noreply@|@(types|modelcontextprotocol|vitest|babel)/'

# 5. Somebody's home folder written into a path.
scan "personal home paths" \
  '([A-Za-z]:\\+Users\\+|/home/|/Users/)[A-Za-z0-9._-]+' \
  '(Users\\+|/home/|/Users/)((you|user|username|USERNAME|runner|node|me|agent|screenbox|someone)\b|\.\.|\$|<)'

# 6. Names private to this maintainer, from the untracked list. Matched
#    ignoring case: a name is as private capitalised as it is lowercase.
if [ -f .audit-private ]; then
  while IFS= read -r re; do
    re=${re%%#*}; re=$(echo "$re" | sed 's/[[:space:]]*$//')
    [ -n "$re" ] && scan "private name /$re/" "$re" '^$' -i
  done < .audit-private
fi

if [ "$fail" -eq 0 ]; then
  echo "OK: no private or internal material found in tracked files"
fi
exit $fail

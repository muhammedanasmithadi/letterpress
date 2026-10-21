#!/bin/bash
# Kill the browsers and servers this work leaves behind.
#
# A test run launches a Chromium per file and a server per file, and a run that
# is interrupted -- a timeout, a killed shell -- leaves them running. They are
# headless and idle, so nothing complains, and the next run starts on a machine
# with a dozen stale browsers on it.
#
# The match is on the profile directory, not the binary: every browser this
# project launches has a `letterpress-` profile, and the user's own Chromium
# does not. Nothing here touches a browser that is not ours.
#
# Usage: tools/cleanup.sh [--all]
#   --all  also kill a letterpress server left running from an earlier session
#          and remove the profile directories under /tmp.

set -u

all=0
[ "${1:-}" = "--all" ] && all=1

# The browsers, by the profile directory they were launched with.
for pid in $(pgrep -f 'user-data-dir=.*letterpress' 2>/dev/null); do
  # Never the shell running this script, or a grep whose arguments match.
  cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)
  case "$cmd" in
    *"chromium"* | *"/chrome_crashpad"*) kill -9 "$pid" 2>/dev/null ;;
  esac
done

# A server from an earlier session, if asked for.
if [ "$all" = "1" ]; then
  for pid in $(pgrep -f 'bun src/server.ts' 2>/dev/null); do
    cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)
    case "$cmd" in *"letterpress"*) kill -9 "$pid" 2>/dev/null ;; esac
  done
  rm -rf /tmp/letterpress-* 2>/dev/null
  rm -rf "${TMPDIR:-/tmp}"/letterpress-* 2>/dev/null
fi

sleep 1

left=$(ps -eo cmd 2>/dev/null | grep "chromium-browser/chromium" | grep "letterpress" | grep -vE "grep|pgrep|cleanup.sh" | wc -l)
echo "letterpress browsers still running: $left"

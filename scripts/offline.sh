#!/bin/sh
# Runs a command with the bundled Java runtime and pre-downloaded Firebase emulator files, so the
# emulators start on a machine that has neither Java nor internet access.
#
#   sh scripts/offline.sh npm run emulators
#   sh scripts/offline.sh npm run test:rules
#
# Expects the offline kit unpacked at .offline/ in the project root:
#   .offline/java/linux-x64, .offline/java/linux-aarch64   Java 21 runtimes (glibc Linux)
#   .offline/emulators                                      Firestore, Storage, Pub/Sub and UI files
set -eu

root="$(cd "$(dirname "$0")/.." && pwd)"
kit="$root/.offline"

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) runtime="$kit/java/linux-x64" ;;
  Linux-aarch64 | Linux-arm64) runtime="$kit/java/linux-aarch64" ;;
  *) runtime="" ;;
esac

if [ -n "$runtime" ] && [ -x "$runtime/bin/java" ]; then
  JAVA_HOME="$runtime"
  PATH="$runtime/bin:$PATH"
  export JAVA_HOME PATH
elif ! command -v java >/dev/null 2>&1; then
  echo "offline.sh: no bundled Java for $(uname -s)-$(uname -m) in $kit/java and none on PATH." >&2
  exit 1
fi

if [ ! -d "$kit/emulators" ]; then
  echo "offline.sh: $kit/emulators is missing; unpack the offline kit into the project root." >&2
  exit 1
fi

# Where the Firebase CLI looks for emulator files instead of downloading them.
FIREBASE_EMULATORS_PATH="$kit/emulators"
# Keep the CLI from reaching for the network on start-up.
NO_UPDATE_NOTIFIER=1
FIREBASE_CLI_DISABLE_UPDATE_CHECK=1
export FIREBASE_EMULATORS_PATH NO_UPDATE_NOTIFIER FIREBASE_CLI_DISABLE_UPDATE_CHECK

exec "$@"

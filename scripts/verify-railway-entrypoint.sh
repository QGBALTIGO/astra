#!/bin/sh
# Run only in a disposable candidate-image container; never against a live volume.
set -eu

if [ "${1:-}" = 'verify-child' ]; then
  [ "$(id -u)" = '1001' ]
  [ "$(id -g)" = '1001' ]
  [ "$(stat -c '%u' /app/data/runtime-fixture/private)" = '1001' ]
  [ "$(stat -c '%u' /app/data/runtime-fixture/private/payload)" = '1001' ]
  [ "$(stat -c '%a' /app/data/runtime-fixture/private)" = '700' ]
  [ "$(stat -c '%a' /app/data/runtime-fixture/private/payload)" = '600' ]
  [ "$(cat /app/data/runtime-fixture/private/payload)" = 'private-preservation-fixture' ]
  [ "$(stat -c '%u' /tmp/runtime-outside-fixture)" = '0' ]
  [ "$2" = 'argument with spaces' ]
  [ "$3" = 'literal-$-*' ]
  printf '%s\n' 'runtime-private-data-readable-without-root'
  exit 0
fi

[ "$(id -u)" = '0' ]
printf '%s\n' 'outside-fixture' > /tmp/runtime-outside-fixture
chmod 600 /tmp/runtime-outside-fixture

if [ "${1:-}" = 'reject-data-symlink' ]; then
  mv /app/data /app/runtime-original-data
  ln -s /tmp /app/data
  status=0
  /usr/local/bin/railway-entrypoint.sh /bin/sh -c 'printf "unexpected-server-start\n"' > /tmp/runtime-refusal.log 2>&1 || status=$?
  [ "$status" = '1' ]
  grep -Fq 'Symlink data root refused' /tmp/runtime-refusal.log
  if grep -Fq 'unexpected-server-start' /tmp/runtime-refusal.log; then
    exit 1
  fi
  [ "$(stat -c '%u' /tmp/runtime-outside-fixture)" = '0' ]
  printf '%s\n' 'runtime-symlink-root-refused'
  exit 0
fi

# Reproduce the historical override: the parent is already correct, but a
# privileged process left private files and directories owned by root beneath it.
chown ownpilot:ownpilot /app/data
mkdir -p /app/data/runtime-fixture/private
printf '%s\n' 'private-preservation-fixture' > /app/data/runtime-fixture/private/payload
chmod 700 /app/data/runtime-fixture/private
chmod 600 /app/data/runtime-fixture/private/payload
ln -s /tmp/runtime-outside-fixture /app/data/runtime-fixture/outside-link
exec /usr/local/bin/railway-entrypoint.sh /bin/sh "$0" verify-child 'argument with spaces' 'literal-$-*'

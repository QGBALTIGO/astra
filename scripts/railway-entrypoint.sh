#!/bin/sh
set -eu

# Railway volumes can be mounted as root even if the image's data
# directory was chowned during docker build. Fix only the mounted
# data directory, then drop privileges before running Node.
if [ "$(id -u)" -eq 0 ]; then
  if [ -L /app/data ]; then
    printf '%s\n' '[RuntimeIdentity] Symlink data root refused; server startup stopped.' >&2
    exit 1
  fi
  if [ -d /app/data ]; then
    # A previous start-command override may have created root-owned descendants
    # even when the volume root already belongs to ownpilot. Normalize the whole
    # application-owned tree, without following links outside the data volume.
    chown -hR ownpilot:ownpilot /app/data
  fi
  # Re-enter as the volume owner, preserving the exact original server command.
  exec su-exec ownpilot /usr/local/bin/railway-entrypoint.sh "$@"
fi

printf '{"level":"info","msg":"Astra runtime identity","uid":%s,"gid":%s}\n' "$(id -u)" "$(id -g)"

if [ -n "${ASTRA_RELEASE_BACKUP_LABEL:-}" ]; then
  # Standalone module: no gateway adapters or migrations are imported before this gate.
  node /app/packages/gateway/dist/release-backup.js
fi

exec "$@"

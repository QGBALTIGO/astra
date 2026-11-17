#!/bin/sh
set -eu

# Railway volumes can be mounted as root even if the image's data
# directory was chowned during docker build. Fix only the mounted
# data directory, then drop privileges before running Node.
if [ "$(id -u)" -eq 0 ]; then
  if [ -d /app/data ] && [ "$(stat -c '%u' /app/data)" != "1001" ]; then
    chown -R ownpilot:ownpilot /app/data
  fi
  # Re-enter as the volume owner, preserving the exact original server command.
  exec su-exec ownpilot /usr/local/bin/railway-entrypoint.sh "$@"
fi

if [ -n "${ASTRA_RELEASE_BACKUP_LABEL:-}" ]; then
  # Standalone module: no gateway adapters or migrations are imported before this gate.
  node /app/packages/gateway/dist/release-backup.js
fi

exec "$@"

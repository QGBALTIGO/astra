#!/bin/sh
set -eu

# Railway volumes can be mounted as root even if the image's data
# directory was chowned during docker build. Fix only the mounted
# data directory, then drop privileges before running Node.
if [ "$(id -u)" -eq 0 ]; then
  if [ -d /app/data ] && [ "$(stat -c '%u' /app/data)" != "1001" ]; then
    chown -R ownpilot:ownpilot /app/data
  fi
  exec su-exec ownpilot "$@"
fi

exec "$@"

#!/usr/bin/env bash
# The `bridge` target in docker/Dockerfile mirrors upstream's own
# containers/cursor-sdk-bridge/Dockerfile. If upstream changes theirs, review
# the diff and mirror it, then update docker/bridge-dockerfile.sha256.
set -euo pipefail
cd "$(dirname "$0")/.."
ACTUAL=$(shasum -a 256 containers/cursor-sdk-bridge/Dockerfile | cut -d' ' -f1)
EXPECTED=$(tr -d '[:space:]' < docker/bridge-dockerfile.sha256)
if [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "Upstream bridge Dockerfile changed."
  echo "Mirror any change into the 'bridge' target of docker/Dockerfile, then run:"
  echo "  echo $ACTUAL > docker/bridge-dockerfile.sha256"
  echo "--- current upstream version ---"
  cat containers/cursor-sdk-bridge/Dockerfile
  exit 1
fi
echo "No bridge Dockerfile drift."

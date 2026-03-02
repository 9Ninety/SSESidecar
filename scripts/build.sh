#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
IMAGE_NAME="sse-sidecar"
TAG="${1:-$(date +%Y%m%d%H%M)}"

cd "$REPO_ROOT"
docker build -t "$IMAGE_NAME:$TAG" .

echo "Built $IMAGE_NAME:$TAG"

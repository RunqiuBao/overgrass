#!/usr/bin/env bash
#
# Build and run Overgrass (the local Overleaf) in Docker.
# The image bundles Node + a TeX distribution so LaTeX compiles inside the
# container — no host TeX install required.
#
# Usage:
#   scripts/docker.sh build      # build the image only
#   scripts/docker.sh up         # build (if needed) and start the container
#   scripts/docker.sh down       # stop and remove the container
#   scripts/docker.sh logs       # follow container logs
#   scripts/docker.sh restart    # down + up
#   scripts/docker.sh shell      # open a shell inside the running container
#
# Configuration (environment variables):
#   IMAGE         image tag            (default: overgrass:latest)
#   CONTAINER     container name       (default: overgrass)
#   PORT          host port to expose  (default: 3001)
#   DATA_DIR      host directory to store projects in (bind mount). When set,
#                 your projects live in this folder on your disk, e.g.
#                   DATA_DIR=~/overgrass-projects scripts/docker.sh up
#   DATA_VOLUME   docker named volume to use when DATA_DIR is NOT set
#                 (default: overgrass-data, managed under /var/lib/docker/volumes)
#   TEX_PACKAGES  apt packages to install for TeX
#                 (default: "texlive-full latexmk"; override for a smaller image)
#
# On first run this also installs an `overgrass` shell function into ~/.bashrc so
# you can run `overgrass up|down|restart|…` from anywhere. Set OVERGRASS_NO_ALIAS=1
# to skip that.
#
set -euo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$PWD"
SELF_PATH="$REPO_ROOT/scripts/docker.sh"

IMAGE="${IMAGE:-overgrass:latest}"
CONTAINER="${CONTAINER:-overgrass}"
PORT="${PORT:-3001}"
DATA_DIR="${DATA_DIR:-}"
DATA_VOLUME="${DATA_VOLUME:-overgrass-data}"
TEX_PACKAGES="${TEX_PACKAGES:-texlive-full latexmk}"

# Decide what to mount at /data: an explicit host directory (bind mount) if
# DATA_DIR is given, otherwise the managed named volume.
if [ -n "${DATA_DIR}" ]; then
  mkdir -p "${DATA_DIR}"
  DATA_MOUNT="$(cd "${DATA_DIR}" && pwd):/data"
  DATA_DESC="host directory $(cd "${DATA_DIR}" && pwd)"
else
  DATA_MOUNT="${DATA_VOLUME}:/data"
  DATA_DESC="docker volume ${DATA_VOLUME} (docker volume inspect ${DATA_VOLUME})"
fi

usage() {
  cat <<EOF
overgrass — manage the Overgrass (local Overleaf) Docker container.

Usage:
  overgrass <command>
  overgrass -h | --help

Commands:
  up         Build the image (if needed) and start the container   [default]
  down       Stop and remove the container
  restart    down + up (rebuild and restart)
  build      Build the image only
  logs       Follow the container logs
  shell      Open a shell inside the running container
  help       Show this help

Environment variables:
  DATA_DIR            Host folder to store projects in (bind mount).
                      e.g.  DATA_DIR=~/overgrass-projects overgrass up
  DATA_VOLUME         Docker named volume when DATA_DIR is unset (default: overgrass-data)
  PORT                Host port to expose (default: 3001)
  IMAGE               Image tag (default: overgrass:latest)
  CONTAINER           Container name (default: overgrass)
  TEX_PACKAGES        apt TeX packages to install (default: "texlive-full latexmk")
  OVERGRASS_NO_ALIAS  Set to skip installing the overgrass alias into ~/.bashrc

Once running, open http://localhost:\${PORT:-3001}
EOF
}

# Show help early — before the alias install and docker check — so it works
# regardless of environment.
case "${1:-}" in
  -h|--help|help) usage; exit 0 ;;
esac

# Install an `overgrass` shell function into ~/.bashrc (idempotent) so the user
# can manage the container from anywhere. Disable with OVERGRASS_NO_ALIAS=1.
install_alias() {
  [ -n "${OVERGRASS_NO_ALIAS:-}" ] && return 0
  [ -z "${HOME:-}" ] && return 0
  local rc="${HOME}/.bashrc"
  if [ -f "$rc" ] && grep -q '# >>> overgrass >>>' "$rc"; then
    return 0
  fi
  cat >> "$rc" <<EOF

# >>> overgrass >>>
# Manage the Overgrass (local Overleaf) Docker container from anywhere.
# Usage:  overgrass up|down|restart|build|logs|shell   (e.g. DATA_DIR=~/projects overgrass up)
overgrass() {
  bash "$SELF_PATH" "\$@"
}
# <<< overgrass <<<
EOF
  echo ">> Installed the 'overgrass' command in $rc"
  echo "   Run 'source $rc' (or open a new terminal), then use: overgrass up | down | restart"
}
install_alias

command -v docker >/dev/null 2>&1 || { echo "error: docker is not installed or not on PATH." >&2; exit 1; }

build() {
  echo ">> Building ${IMAGE} (TeX: ${TEX_PACKAGES})"
  echo "   Note: installing texlive-full downloads several GB — the first build is slow."
  docker build --build-arg TEX_PACKAGES="${TEX_PACKAGES}" -t "${IMAGE}" .
}

up() {
  build
  echo ">> Removing any existing container named ${CONTAINER}"
  docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
  echo ">> Starting ${CONTAINER}"
  # Forward Claude assistant config into the container when set on the host.
  ENV_ARGS=()
  for var in ANTHROPIC_API_KEY OVERGRASS_ANTHROPIC_KEY CLAUDE_CODE_OAUTH_TOKEN OVERGRASS_CLAUDE_MODEL; do
    if [ -n "${!var:-}" ]; then ENV_ARGS+=(-e "${var}=${!var}"); fi
  done
  docker run -d \
    --name "${CONTAINER}" \
    -p "${PORT}:3001" \
    -v "${DATA_MOUNT}" \
    ${ENV_ARGS[@]+"${ENV_ARGS[@]}"} \
    --restart unless-stopped \
    "${IMAGE}"
  echo ""
  echo "   Overgrass is starting at  http://localhost:${PORT}"
  echo "   Projects stored in: ${DATA_DESC}"
  echo "   Follow logs with:  scripts/docker.sh logs"
}

down() {
  echo ">> Stopping and removing ${CONTAINER}"
  docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
}

case "${1:-up}" in
  build)            build ;;
  up)               up ;;
  down)             down ;;
  restart)          down; up ;;
  logs)             docker logs -f "${CONTAINER}" ;;
  shell)            docker exec -it "${CONTAINER}" bash ;;
  help|-h|--help)   usage ;;
  *)
    echo "error: unknown command '$1'" >&2
    echo >&2
    usage >&2
    exit 1
    ;;
esac

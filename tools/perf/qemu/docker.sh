#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
BASE_IMAGE=${POCKETJS_QEMU_BASE_IMAGE:-pocketjs-perf-qemu-base:11.0.3}
IMAGE=${POCKETJS_QEMU_IMAGE:-pocketjs-perf-qemu:11.0.3}
COMMAND=${1:-test}

build_image() {
    docker build --file "$SCRIPT_DIR/Dockerfile" --tag "$BASE_IMAGE" "$SCRIPT_DIR"
    docker build --file "$SCRIPT_DIR/Dockerfile.runner" \
        --build-arg "QEMU_BASE_IMAGE=$BASE_IMAGE" --tag "$IMAGE" "$SCRIPT_DIR"
}

case "$COMMAND" in
    build)
        build_image
        ;;
    test)
        build_image
        docker run --rm "$IMAGE"
        ;;
    shell)
        build_image
        docker run --rm -it --entrypoint /bin/sh "$IMAGE"
        ;;
    *)
        echo "usage: $0 [build|test|shell]" >&2
        exit 64
        ;;
esac

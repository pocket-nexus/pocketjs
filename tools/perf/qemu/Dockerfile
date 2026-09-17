FROM debian:bookworm-slim@sha256:abd67ffcfa541b485a3dff59865ab629aa048a6c613e639d36e7456b0b229241

ARG DEBIAN_SNAPSHOT=20260803T000000Z
ARG QEMU_VERSION=11.0.3
ARG QEMU_SHA256=da5fcffc32762820568b828ed430a728864d34d50b6d2f30358597760cbb0523

ENV DEBIAN_FRONTEND=noninteractive

RUN rm -f /etc/apt/sources.list.d/debian.sources && \
    printf '%s\n' \
      "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT} bookworm main" \
      "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT} bookworm-updates main" \
      "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT} bookworm-security main" \
      > /etc/apt/sources.list && \
    apt-get -o Acquire::Check-Valid-Until=false update && \
    apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      curl \
      gcc-aarch64-linux-gnu \
      gcc-arm-linux-gnueabihf \
      libglib2.0-dev \
      ninja-build \
      pkg-config \
      python3 && \
    rm -rf /var/lib/apt/lists/*

# QEMU creates an isolated build environment for its bundled Python tooling.
RUN apt-get -o Acquire::Check-Valid-Until=false update && \
    apt-get install -y --no-install-recommends python3-venv && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /tmp/qemu-source
RUN curl -fsSLo qemu.tar.xz \
      "https://download.qemu.org/qemu-${QEMU_VERSION}.tar.xz" && \
    echo "${QEMU_SHA256}  qemu.tar.xz" | sha256sum --check - && \
    tar -xJf qemu.tar.xz --strip-components=1 && \
    rm qemu.tar.xz && \
    ./configure \
      --prefix=/opt/qemu \
      --target-list=arm-linux-user,aarch64-linux-user \
      --enable-linux-user \
      --disable-system \
      --enable-plugins \
      --disable-docs \
      --disable-tools \
      --disable-debug-info \
      --enable-strip && \
    ninja -C build -j2 && \
    ninja -C build install && \
    rm -rf /tmp/qemu-source

# The cross-GCC metapackages only recommend their C library development
# sysroots; install both explicitly because recommended packages are disabled.
RUN apt-get -o Acquire::Check-Valid-Until=false update && \
    apt-get install -y --no-install-recommends \
      libc6-dev-arm64-cross \
      libc6-dev-armhf-cross && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /opt/pocketjs-perf-qemu
COPY . .
RUN make all && make test-parser

ENV QEMU_PREFIX=/opt/qemu
CMD ["./run-fixtures.sh"]

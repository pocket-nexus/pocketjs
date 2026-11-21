ARG POCKETJS_SYMBIAN_BASE_IMAGE=debian:bullseye-slim@sha256:de70627667ac77b32ab6858f1acddfb04a4ff3acc1095ac17dbc19fe5725bcb6
FROM ${POCKETJS_SYMBIAN_BASE_IMAGE}

ARG POCKETJS_DEBIAN_SNAPSHOT
ARG POCKETJS_DEBIAN_SECURITY_SNAPSHOT
ENV DEBIAN_FRONTEND=noninteractive

RUN rm -f /etc/apt/sources.list.d/* \
    && { \
        echo "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/${POCKETJS_DEBIAN_SNAPSHOT}/ bullseye main"; \
        echo "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/${POCKETJS_DEBIAN_SECURITY_SNAPSHOT}/ bullseye-security main"; \
        echo "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/${POCKETJS_DEBIAN_SNAPSHOT}/ bullseye-updates main"; \
    } > /etc/apt/sources.list \
    && dpkg --add-architecture i386 \
    && apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=60 update \
    && apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=60 install \
        -y --no-install-recommends \
        autoconf \
        automake \
        bison \
        bzip2 \
        ca-certificates \
        file \
        flex \
        g++ \
        gcc \
        jq \
        libc6:i386 \
        libc6-i386 \
        libdigest-sha-perl \
        libfile-copy-recursive-perl \
        libssl-dev \
        libstdc++6:i386 \
        libtext-template-perl \
        libxml-simple-perl \
        make \
        openssl \
        p7zip-full \
        patch \
        perl \
        pkg-config \
        unzip \
        xz-utils \
        zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

RUN apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=60 update \
    && apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=60 install \
        -y --no-install-recommends \
        libfontconfig1-dev \
        libfreetype6-dev \
        libx11-dev \
        libxext-dev \
        libxrender-dev \
    && rm -rf /var/lib/apt/lists/*

ARG POCKETJS_SYMBIAN_IMPLEMENTATION_SHA256
ARG POCKETJS_SYMBIAN_TOOLCHAIN_VERSION
ENV POCKETJS_SYMBIAN_IMAGE_IMPLEMENTATION_SHA256="${POCKETJS_SYMBIAN_IMPLEMENTATION_SHA256}"

LABEL org.pocketjs.symbian.toolchain="${POCKETJS_SYMBIAN_TOOLCHAIN_VERSION}" \
      org.pocketjs.symbian.implementation="${POCKETJS_SYMBIAN_IMPLEMENTATION_SHA256}"

COPY tools/build/toolchains/symbian/manifest.json /opt/pocketjs/symbian-toolchain.json
COPY tools/symbian/container/patches /opt/pocketjs/patches
# Repository command entrypoints use Bun TypeScript by default. These shell
# entrypoints are the documented exception: the pinned, network-disabled
# linux/amd64 toolchain image intentionally does not install Bun, while all
# host-side orchestration remains in tools/*.ts.
COPY tools/symbian/container/pocketjs-symbian-setup /usr/local/bin/
COPY tools/symbian/container/pocketjs-symbian-doctor /usr/local/bin/
COPY tools/symbian/container/pocketjs-symbian-build-probe /usr/local/bin/
COPY tools/symbian/container/pocketjs-symbian-build-app /usr/local/bin/
COPY tools/symbian/container/symbian-gcce-link /usr/local/bin/

RUN chmod 0755 \
        /usr/local/bin/pocketjs-symbian-setup \
        /usr/local/bin/pocketjs-symbian-doctor \
        /usr/local/bin/pocketjs-symbian-build-probe \
        /usr/local/bin/pocketjs-symbian-build-app \
        /usr/local/bin/symbian-gcce-link

WORKDIR /work

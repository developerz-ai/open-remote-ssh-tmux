# Real-tmux rig: one sshd container per tmux version under test (see compose.yml).
#
# Every unit test fakes `exec` and tmux, which is how the `=name:` target bug shipped
# (docs/plans/2026/07/24/102-bug-audit-fixes/status.yml). This image is the remote the
# integration tests (`test/integration/*.itest.ts`, `npm run test:tmux`) talk to over
# real ssh2: tmux built from the pinned release tarball (checksum-verified), plus the
# login shells real remotes run, so command lines are exercised under each of them.
#
# Throwaway by design: no key is baked in. `run.sh` generates an ed25519 key per run and
# hands its PUBLIC half in through `RIG_AUTHORIZED_KEY`; the entrypoint installs it.

ARG DEBIAN_IMAGE=debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc

FROM ${DEBIAN_IMAGE} AS build
# Shared by every version, so BuildKit builds this layer once for the whole matrix.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bison build-essential ca-certificates curl libevent-dev libncurses-dev pkg-config \
  && rm -rf /var/lib/apt/lists/*
ARG TMUX_VERSION
ARG TMUX_SHA256
WORKDIR /src
# `-fcommon`: tmux <= 3.0a defines globals in headers, which GCC >= 10 rejects as
# multiple definitions under its default `-fno-common`. Harmless for newer releases.
RUN test -n "${TMUX_VERSION}" && test -n "${TMUX_SHA256}" \
  && curl -fsSL -o tmux.tar.gz "https://github.com/tmux/tmux/releases/download/${TMUX_VERSION}/tmux-${TMUX_VERSION}.tar.gz" \
  && echo "${TMUX_SHA256}  tmux.tar.gz" | sha256sum -c - \
  && tar -xzf tmux.tar.gz --strip-components=1 \
  && ./configure --prefix=/usr/local CFLAGS="-O2 -fcommon" \
  && make -j"$(nproc)" \
  && make install

FROM ${DEBIAN_IMAGE}
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash dash fish libevent-2.1-7 libevent-core-2.1-7 libncursesw6 openssh-server procps \
    tcsh util-linux zsh \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/bin/tmux /usr/local/bin/tmux
# Fail the build, not the test run, if the binary cannot start (missing shared lib).
RUN tmux -V
COPY sshd_config /etc/ssh/sshd_config.d/rig.conf
COPY entrypoint.sh /usr/local/sbin/rig-entrypoint
# Host keys are generated per image build and never leave it; tests do not pin them.
# Login users: one per login shell (`u-<shell>`) for shell-sensitivity tests, plus bash
# "worker" users `w1`..`w8` — each integration test file runs as its own worker, so
# every file gets a private tmux server (sockets are per uid) and files run in parallel.
# Every interactive session gets a UTF-8 locale, as a real remote would: tmux replaces
# non-ASCII with `_` under the C locale.
RUN ssh-keygen -A \
  && mkdir -p /run/sshd \
  && chmod 0755 /usr/local/sbin/rig-entrypoint \
  && echo 'LANG=C.UTF-8' >> /etc/environment \
  && for shell in bash zsh fish dash tcsh; do \
    useradd --create-home --shell "$(command -v "${shell}")" "u-${shell}"; \
  done \
  && for n in 1 2 3 4 5 6 7 8; do \
    useradd --create-home --shell /bin/bash "w${n}"; \
  done
EXPOSE 22
ENTRYPOINT ["/usr/local/sbin/rig-entrypoint"]

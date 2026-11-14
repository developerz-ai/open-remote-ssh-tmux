# EDH remote: the real-tmux rig image (test/rig/Dockerfile, built first by run.sh) plus a
# login user `wedh` with the VSCodium remote extension host (REH) pre-installed where the
# extension's install script looks for it — so a connect never downloads ~70 MB from GitHub
# and the remote needs no wget/curl (the rig image has neither, by design).
#
# The user is named `wedh` because the rig's sshd only admits `u-*` and `w*`
# (test/rig/sshd_config); the rig entrypoint installs the run's throwaway key for every
# /home/* user, this one included.

ARG RIG_IMAGE=orst-tmux-rig:3.4
ARG DEBIAN_IMAGE=debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc

FROM ${DEBIAN_IMAGE} AS reh
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
ARG VSCODIUM_VERSION
ARG REH_SHA256
WORKDIR /reh
# `--strip-components 1` mirrors src/scripts/server-setup.sh's own extraction.
RUN test -n "${VSCODIUM_VERSION}" && test -n "${REH_SHA256}" \
  && curl -fsSL -o /tmp/reh.tar.gz "https://github.com/VSCodium/vscodium/releases/download/${VSCODIUM_VERSION}/vscodium-reh-linux-x64-${VSCODIUM_VERSION}.tar.gz" \
  && echo "${REH_SHA256}  /tmp/reh.tar.gz" | sha256sum -c - \
  && tar -xzf /tmp/reh.tar.gz --strip-components 1 \
  && rm /tmp/reh.tar.gz \
  && test -x bin/codium-server

FROM ${RIG_IMAGE}
COPY --from=reh /reh /opt/vscodium-reh
# Install path = $HOME/<serverDataFolderName>/bin/<commit> (server-setup.sh: SERVER_DIR),
# both values read from the REH's own product.json so a version bump needs no edit here.
#
# `wpw` is the base-experience password-auth user: same REH, but sshd accepts ONLY a
# password for it (the Match block below; the rig drop-in turns passwords off for everyone
# else). It has no password in the image — row 51 sets a random one per run with chpasswd.
RUN product=/opt/vscodium-reh/product.json \
  && commit=$(sed -n 's/^[[:space:]]*"commit":[[:space:]]*"\([0-9a-f]*\)".*/\1/p' "${product}") \
  && data=$(sed -n 's/^[[:space:]]*"serverDataFolderName":[[:space:]]*"\([^"]*\)".*/\1/p' "${product}") \
  && test -n "${commit}" && test -n "${data}" \
  && for user in wedh wpw; do \
    useradd --create-home --shell /bin/bash "${user}" \
    && install -d -o "${user}" -g "${user}" "/home/${user}/${data}" "/home/${user}/${data}/bin" "/home/${user}/ws" \
    && cp -a /opt/vscodium-reh "/home/${user}/${data}/bin/${commit}" \
    && chown -R "${user}:${user}" "/home/${user}/${data}" \
    || exit 1; \
  done \
  && printf '\nMatch User wpw\n  PasswordAuthentication yes\n  AuthenticationMethods password\n' >> /etc/ssh/sshd_config \
  && sshd -t \
  && echo "edh: REH ${commit} installed under /home/{wedh,wpw}/${data}"

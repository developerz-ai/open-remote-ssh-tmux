# EDH client: one "machine" running real VSCodium under its own Xvfb, driven by xdotool,
# screenshotted with ImageMagick `import`. Nothing GUI ever touches the host display — the
# X server lives and dies with this container. The extension under test is NOT baked in:
# the entrypoint installs whatever .vsix run.sh mounts, so the same image re-tests any build.

ARG DEBIAN_IMAGE=debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc
FROM ${DEBIAN_IMAGE}

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates curl fonts-dejavu-core imagemagick iproute2 openssh-client procps \
    x11-utils xauth xdotool xvfb zip \
    libasound2 libatk-bridge2.0-0 libatk1.0-0 libcups2 libdrm2 libgbm1 libgtk-3-0 \
    libnss3 libsecret-1-0 libx11-xcb1 libxcomposite1 libxdamage1 libxkbfile1 libxrandr2 \
    libxss1 libxshmfence1 \
  && rm -rf /var/lib/apt/lists/*

ARG VSCODIUM_VERSION
ARG VSCODIUM_SHA256
RUN test -n "${VSCODIUM_VERSION}" && test -n "${VSCODIUM_SHA256}" \
  && curl -fsSL -o /tmp/codium.tar.gz "https://github.com/VSCodium/vscodium/releases/download/${VSCODIUM_VERSION}/VSCodium-linux-x64-${VSCODIUM_VERSION}.tar.gz" \
  && echo "${VSCODIUM_SHA256}  /tmp/codium.tar.gz" | sha256sum -c - \
  && mkdir -p /opt/vscodium \
  && tar -xzf /tmp/codium.tar.gz -C /opt/vscodium \
  && rm /tmp/codium.tar.gz \
  && ln -s /opt/vscodium/bin/codium /usr/local/bin/codium \
  && test -x /opt/vscodium/bin/codium && test -x /opt/vscodium/codium

# The "machine user". uid 1000 is arbitrary; the entrypoint copies the key in as root.
RUN useradd --create-home --uid 1000 --shell /bin/bash pc
COPY client/settings.json client/keybindings.json /etc/edh-client/
# Row 17's probe extension, zipped into a .vsix the way vsce lays one out (manifest + content
# types at the root, the extension under extension/); installed onto the REMOTE by the row.
COPY fixtures/edh-probe-ext /opt/edh/edh-probe-src
RUN cd /opt/edh/edh-probe-src \
  && mkdir -p /tmp/vsix/extension \
  && cp extension.vsixmanifest '[Content_Types].xml' /tmp/vsix/ \
  && cp package.json extension.js /tmp/vsix/extension/ \
  && cd /tmp/vsix && zip -qr /opt/edh/edh-probe-0.0.1.vsix . \
  && rm -rf /tmp/vsix
COPY client/entrypoint.sh /usr/local/sbin/edh-client
RUN chmod 0755 /usr/local/sbin/edh-client
ENTRYPOINT ["/usr/local/sbin/edh-client"]

// Row 17 fixture (test/rig/edh/rows/17-editing-path.sh): on activation, record the host it
// runs on. Installed from a remote window, a workspace-kind extension runs in the REMOTE
// extension host, so the file must appear on the remote and never on the client.
'use strict';
const fs = require('fs');
const os = require('os');

exports.activate = () => {
    fs.writeFileSync('/tmp/edh-probe-ext.activated', `${os.hostname()} ${process.pid}\n`);
};
exports.deactivate = () => undefined;

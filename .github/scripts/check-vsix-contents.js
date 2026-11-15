#!/usr/bin/env node
'use strict';

// Packaging guard: the `.vsix` must contain exactly what `.vscodeignore`
// whitelists. `.vscodeignore` excludes everything (`*`, `*/**`) and re-includes
// the shipped files with `!` lines, so a typo there either drops a file the
// extension needs at runtime (`lib/extension.js`, the remote install scripts)
// or leaks the repo into the marketplace package. Both only surfaced at
// release; this turns them into a CI failure on the pull request.
//
// The `!` lines are the expected list. Supported forms are an exact path and a
// `dir/**` subtree — anything else is rejected rather than guessed at.
// Names compare case-insensitively because vsce lowercases README/CHANGELOG.
//
// Usage:
//   node .github/scripts/check-vsix-contents.js <file.vsix>

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/** vsce's own package metadata, outside the `extension/` payload. */
const VSIX_METADATA = new Set(['extension.vsixmanifest', '[content_types].xml']);
const PAYLOAD_PREFIX = 'extension/';

/** The re-included (`!`) patterns of a `.vscodeignore`. */
function whitelistPatterns(vscodeignore) {
    const patterns = vscodeignore
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line.startsWith('!'))
        .map(line => line.slice(1));

    for (const pattern of patterns) {
        const body = pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern;
        if (body === '' || /[*?[\]{}]/.test(body)) {
            throw new Error(`Unsupported .vscodeignore whitelist pattern "!${pattern}": use an exact path or "dir/**".`);
        }
    }
    return patterns;
}

function matches(file, pattern) {
    const lowerPattern = pattern.toLowerCase();
    return lowerPattern.endsWith('/**')
        ? file.startsWith(lowerPattern.slice(0, -2))
        : file === lowerPattern;
}

/**
 * Compare the archive's entry names with the whitelist.
 * `unexpected`: payload files no pattern admits. `missing`: patterns nothing matched.
 */
function compareEntries(entries, patterns) {
    const files = [];
    const unexpected = [];

    for (const entry of entries.map(name => name.trim()).filter(name => name !== '' && !name.endsWith('/'))) {
        const lower = entry.toLowerCase();
        if (VSIX_METADATA.has(lower)) {
            continue;
        }
        if (!lower.startsWith(PAYLOAD_PREFIX)) {
            unexpected.push(entry);
            continue;
        }
        files.push(lower.slice(PAYLOAD_PREFIX.length));
    }

    for (const file of files) {
        if (!patterns.some(pattern => matches(file, pattern))) {
            unexpected.push(`${PAYLOAD_PREFIX}${file}`);
        }
    }
    const missing = patterns.filter(pattern => !files.some(file => matches(file, pattern)));

    return { unexpected, missing };
}

function main(args) {
    const vsix = args[0];
    if (!vsix) {
        throw new Error('Usage: check-vsix-contents.js <file.vsix>');
    }

    const root = path.resolve(__dirname, '..', '..');
    const patterns = whitelistPatterns(fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8'));
    const entries = execFileSync('unzip', ['-Z1', vsix], { encoding: 'utf8' }).split('\n');
    const { unexpected, missing } = compareEntries(entries, patterns);

    if (unexpected.length > 0 || missing.length > 0) {
        for (const entry of unexpected) {
            console.error(`FAIL: ${vsix} contains ${entry}, which .vscodeignore does not whitelist`);
        }
        for (const pattern of missing) {
            console.error(`FAIL: ${vsix} has nothing for the .vscodeignore whitelist entry !${pattern}`);
        }
        process.exit(1);
    }

    console.log(`OK: ${vsix} matches the .vscodeignore whitelist (${patterns.join(', ')})`);
}

module.exports = { whitelistPatterns, compareEntries };

if (require.main === module) {
    try {
        main(process.argv.slice(2));
    }
    catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}

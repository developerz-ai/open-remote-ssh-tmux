const fs = require('fs');
const path = require('path');

/**
 * The notes under `## <version>` (tag `v<version>`), up to the next `## ` heading or the
 * end of the file; undefined when there is no such section. The heading must be the
 * version exactly, so `v1.4.2` never picks up a `## 1.4.20` above it, and `###`
 * subheadings stay inside the section.
 */
function changelogEntry(changelog, tag) {
    const lines = changelog.split(/\r?\n/);
    const start = lines.findIndex(line => line.trimEnd() === `## ${tag.replace(/^v/, '')}`);
    if (start === -1) {
        return undefined;
    }
    const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
    return lines.slice(start + 1, end === -1 ? undefined : end).join('\n').trim();
}

module.exports = { changelogEntry };

if (require.main === module) {
    // Version from the command line, with the 'v' prefix.
    const version = process.argv[2];
    if (!version) {
        console.error('Usage: get-changelog.js v<version>');
        process.exit(1);
    }

    const notes = changelogEntry(fs.readFileSync(path.join(process.cwd(), 'CHANGELOG.md'), 'utf8'), version);
    if (notes === undefined) {
        console.error(`No changelog entry found for version ${version}`);
        process.exit(1);
    }
    console.log(notes);
}

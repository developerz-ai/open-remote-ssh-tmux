const fs = require('fs');
const path = require('path');

/** One file per release: docs/changelog/<version>.md, relative to the repository root. */
function changelogFile(version) {
    return path.posix.join('docs', 'changelog', `${version.replace(/^v/, '')}.md`);
}

/**
 * The notes in a release file: everything after its `# <version>` title and the optional
 * `_Released <date>_` line, trimmed. Undefined when the title names another version, so a
 * misnamed or copied file is never published as this release's notes.
 */
function changelogBody(contents, version) {
    const lines = contents.split(/\r?\n/);
    if (lines[0].trimEnd() !== `# ${version.replace(/^v/, '')}`) {
        return undefined;
    }
    let start = 1;
    while (start < lines.length && lines[start].trim() === '') {
        start++;
    }
    if (/^_Released \d{4}-\d{2}-\d{2}_$/.test(lines[start] ?? '')) {
        start++;
    }
    return lines.slice(start).join('\n').trim();
}

module.exports = { changelogFile, changelogBody };

if (require.main === module) {
    // Version from the command line, with or without the 'v' prefix.
    const version = process.argv[2];
    if (!version) {
        console.error('Usage: get-changelog.js v<version>');
        process.exit(1);
    }

    const file = changelogFile(version);
    let contents;
    try {
        contents = fs.readFileSync(path.join(process.cwd(), file), 'utf8');
    }
    catch (error) {
        console.error(`No changelog file ${file} for version ${version}: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }

    const notes = changelogBody(contents, version);
    if (notes === undefined) {
        console.error(`${file} does not start with "# ${version.replace(/^v/, '')}"`);
        process.exit(1);
    }
    if (notes === '') {
        console.error(`${file} has no release notes`);
        process.exit(1);
    }
    console.log(notes);
}

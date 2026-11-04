// Commitlint configuration (see .commitlintrc.yml history — migrated to JS so the
// `ignores` predicate below can be expressed; YAML cannot hold functions).
//
// Release/version-bump commits do not carry a Conventional-Commits type:
// `release-it` is configured to commit `v${version}` (see .release-it.yml) and
// earlier manual bumps used `chore: version x.y.z`. Neither satisfies the strict
// `type-enum` below, so exempt those commit shapes — the release workflow and the
// existing history pass, while every normal commit still obeys the type policy.
//
// A squash-merged pull request carries no Conventional-Commits type either:
// GitHub takes the subject from the PR title and appends the PR number, so the
// subject reads "Ensure staged checks run reliably (#35)". `type-empty` and
// `subject-empty` reject that shape, so exempt it as well — but only that shape:
// a subject with no `type:` prefix that ends in a PR reference. A subject that
// does declare a type (`chore: …`, `note: …`) is still judged by `type-enum`,
// and an untyped subject without a PR reference is still rejected.

// The header pattern of the parser this config runs under
// (conventional-changelog-conventionalcommits): `type`, optional `(scope)`,
// optional `!`, then ": ". A subject that does not match it is prose, not a
// Conventional-Commits header.
const TYPED_SUBJECT = /^\w*(?:\(.*\))?!?: /;
// GitHub appends the pull request number to the subject of a squash-merge.
const PR_REFERENCE = /\(#\d+\)$/;

module.exports = {
    extends: ['@commitlint/config-conventional'],
    ignores: [
        (message) => /^v\d+\.\d+\.\d+\b/.test(message),
        (message) => /^chore: version \d+\.\d+\.\d+\b/.test(message),
        // The subject of a squash-merged pull request: the PR title plus "(#35)".
        (message) => {
            const subject = message.split('\n')[0].trim();
            return !TYPED_SUBJECT.test(subject) && PR_REFERENCE.test(subject);
        },
        // The automated "land" commits the platform's follow-up lane writes on a
        // pull request branch: `chore(<lane>): land <files>`. Their type is
        // chosen by the machine that writes them, not by anyone in this
        // repository, so `type-enum` refuses a message nobody here could have
        // written — the hook then blocks every automated follow-up commit.
        // Same class as the two shapes above: exempt that one subject shape
        // (a scope is required) and leave every other `chore…` subject to the
        // type policy.
        (message) => /^chore\([^)]*\): land\b/.test(message.split('\n')[0].trim()),
    ],
    rules: {
        'body-max-line-length': [2, 'always', 200],
        'type-enum': [
            2,
            'always',
            [
                'build',
                'ci',
                'docs',
                'enhance',
                'feat',
                'fix',
                'perf',
                'refactor',
                'remodel',
                'revert',
                'style',
                'test',
                'vcs',
            ],
        ],
    },
};

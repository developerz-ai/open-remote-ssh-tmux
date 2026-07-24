// Commitlint configuration (see .commitlintrc.yml history — migrated to JS so the
// `ignores` predicate below can be expressed; YAML cannot hold functions).
//
// Release/version-bump commits do not carry a Conventional-Commits type:
// `release-it` is configured to commit `v${version}` (see .release-it.yml) and
// earlier manual bumps used `chore: version x.y.z`. Neither satisfies the strict
// `type-enum` below, so exempt those commit shapes — the release workflow and the
// existing history pass, while every normal commit still obeys the type policy.
module.exports = {
    extends: ['@commitlint/config-conventional'],
    ignores: [
        (message) => /^v\d+\.\d+\.\d+\b/.test(message),
        (message) => /^chore: version \d+\.\d+\.\d+\b/.test(message),
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

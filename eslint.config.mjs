// @ts-check

import { defineConfig, globalIgnores } from 'eslint/config';
import jsdoc from 'eslint-plugin-jsdoc';
import stylistic from '@stylistic/eslint-plugin';
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

// The repo's own CommonJS tooling scripts run on plain Node; there is no `globals`
// dependency, so name the handful they use rather than adding one.
const nodeCommonJsGlobals = {
    __dirname: 'readonly',
    __filename: 'readonly',
    Buffer: 'readonly',
    console: 'readonly',
    module: 'writable',
    process: 'readonly',
    require: 'readonly',
};

export default defineConfig(
    eslint.configs.recommended,
    tseslint.configs.recommended,
    [
    globalIgnores([
        '**/node_modules/',
        '**/out/',
        '**/lib/',
        '**/*.d.ts',
        // Deliberately-broken input for test/eslint-gate.test.ts, which lints it on its own.
        'test/fixtures/lint/',
    ]),
    {
        plugins: {
            '@stylistic': stylistic,
            jsdoc,
        },
        rules: {
            'constructor-super': 'error',
            curly: 'error',
            eqeqeq: 'error',
            'no-buffer-constructor': 'error',
            'no-caller': 'error',
            'no-case-declarations': 'error',
            'no-debugger': 'error',
            'no-duplicate-case': 'error',
            'no-duplicate-imports': 'error',
            'no-eval': 'error',
            'no-async-promise-executor': 'error',
            'no-extra-semi': 'error',
            'no-new-wrappers': 'error',
            'no-redeclare': 'off',
            'no-sparse-arrays': 'error',
            'no-throw-literal': 'error',
            'no-unsafe-finally': 'error',
            'no-unused-labels': 'error',
            'no-restricted-globals': [
                'error',
                'name',
                'length',
                'event',
                'closed',
                'external',
                'status',
                'origin',
                'orientation',
                'context',
            ],
            'no-var': 'error',
            'jsdoc/no-types': 'error',
            semi: 'off',
            '@stylistic/semi': 'error',
            '@stylistic/member-delimiter-style': 'error',
            '@typescript-eslint/naming-convention': [
                'error',
                {
                    selector: 'class',
                    format: ['PascalCase'],
                }
            ],
            quotes: 'off',
            '@stylistic/quotes': [
                'error',
                'single',
                {
                    allowTemplateLiterals: 'always',
                }
            ],
        },
    },
    {
        // Type-aware rules for the shipped code: a dropped promise in the extension host
        // is an unhandled rejection nobody sees, and a non-exhaustive switch over a union
        // silently ignores a new member. The lint fixture opts in too, so
        // test/eslint-gate.test.ts can prove this block fails the run.
        files: ['src/**/*.ts', 'test/fixtures/lint/**/*.ts'],
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            // VS Code's API returns `Thenable`, not `Promise`; without this the rule
            // misses exactly the calls the extension makes most.
            '@typescript-eslint/no-floating-promises': ['error', { checkThenables: true }],
            '@typescript-eslint/no-misused-promises': 'error',
            '@typescript-eslint/switch-exhaustiveness-check': [
                'error',
                { considerDefaultExhaustiveForUnions: true },
            ],
        },
    },
    {
        // The repo's own CommonJS tooling (build config, maintenance scripts): a light
        // correctness pass. JSDoc types are these files' only type annotations under
        // `// @ts-check`, and the TS house style is not imposed on them — webpack.config.js
        // is upstream's and must not be reformatted.
        files: ['**/*.js'],
        languageOptions: {
            sourceType: 'commonjs',
            globals: nodeCommonJsGlobals,
        },
        rules: {
            '@typescript-eslint/no-require-imports': 'off',
            'jsdoc/no-types': 'off',
            '@stylistic/quotes': 'off',
            '@stylistic/semi': 'off',
        },
    },
]);

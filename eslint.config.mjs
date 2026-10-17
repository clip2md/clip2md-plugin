import obsidianmd from 'eslint-plugin-obsidianmd';

export default [
    { ignores: ['node_modules/**', 'main.js', 'src/**/*.test.ts', 'src/obsidian-test-stub.ts', 'scripts/**', '*.mjs'] },
    ...obsidianmd.configs.recommended,
    { files: ['src/**/*.ts'], languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } }, rules: {
        // Sentence case applies to English prose; Chinese UI and exact credential placeholders have no sentence casing.
        'obsidianmd/ui/sentence-case': ['warn', { ignoreWords: ['Clip2MD'], ignoreRegex: ['[\\u3400-\\u9fff]', '^clip2md_', '^API Key$'] }],
    } },
];

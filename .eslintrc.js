module.exports = {
	root: true,
	env: { node: true, es2022: true },
	parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
	ignorePatterns: ['dist/**', 'node_modules/**', 'coverage/**'],

	overrides: [
		{
			// The nodes themselves: TypeScript rules plus n8n's own conventions.
			// The community config is the one n8n verifies against, so linting
			// with it here means surprises show up locally rather than at review.
			files: ['nodes/**/*.ts', 'credentials/**/*.ts'],
			parser: '@typescript-eslint/parser',
			parserOptions: { project: './tsconfig.json', sourceType: 'module' },
			plugins: ['@typescript-eslint', 'n8n-nodes-base'],
			extends: [
				'plugin:n8n-nodes-base/community',
				'plugin:n8n-nodes-base/nodes',
				'plugin:n8n-nodes-base/credentials',
			],
			rules: {
				'@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
				// This package is a fork published under its own name, which the
				// convention rules cannot know about.
				'n8n-nodes-base/community-package-json-name-still-default': 'off',
				// Two rules disagree here, and only one can be satisfied:
				// -miscased wants a camelCase slug, which is how n8n's built-in
				// nodes reference their own documentation pages; -not-http-url
				// wants a real link, which is what a community node outside that
				// documentation site actually has. We link to the JMAP spec, so
				// the slug rule is the one that does not apply.
				'n8n-nodes-base/cred-class-field-documentation-url-miscased': 'off',
			},
		},
		{
			// Tests: TypeScript, but not part of the shipped node surface, so the
			// n8n convention rules do not apply to them.
			files: ['test/**/*.ts'],
			parser: '@typescript-eslint/parser',
			parserOptions: { sourceType: 'module' },
			plugins: ['@typescript-eslint'],
			rules: {
				'@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
			},
		},
		{
			// Build and tooling scripts. Previously unlinted, which is how a typo
			// in a config file stays invisible until it breaks a release.
			files: ['*.js'],
			parserOptions: { sourceType: 'script' },
			rules: {
				'no-undef': 'error',
				'no-unused-vars': 'error',
			},
		},
	],
};

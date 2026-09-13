import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['test/**/*.test.ts'],
		coverage: {
			provider: 'v8',
			include: ['nodes/**/*.ts'],
			// Node definition files are declarative parameter lists, not logic.
			exclude: ['**/*.node.ts'],
			// Ratchet, not a target. These numbers are the coverage that exists today;
			// they are here to stop it getting worse, and are meant to be raised as
			// tests are added — never lowered to make a red run green.
			thresholds: { lines: 25, functions: 20, branches: 20, statements: 25 },
		},
	},
});

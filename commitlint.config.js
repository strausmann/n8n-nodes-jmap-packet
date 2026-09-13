module.exports = {
	extends: ['@commitlint/config-conventional'],
	rules: {
		'type-enum': [
			2,
			'always',
			['feat', 'fix', 'perf', 'docs', 'style', 'refactor', 'test', 'build', 'ci', 'chore', 'revert'],
		],
		// Scopes follow this package's structure, not another project's.
		'scope-enum': [
			2,
			'always',
			[
				'jmap', // shared JMAP plumbing (GenericFunctions)
				'node', // the Jmap action node
				'trigger', // the JmapTrigger node
				'credentials', // credential types
				'filter', // email query filters
				'deps',
				'ci',
				'release',
				'docs',
			],
		],
	},
};

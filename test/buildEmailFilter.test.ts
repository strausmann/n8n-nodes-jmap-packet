import { describe, it, expect } from 'vitest';
import { buildEmailFilter } from '../nodes/Jmap/GenericFunctions';

describe('buildEmailFilter', () => {
	it('returns an empty filter when no options are set', () => {
		expect(buildEmailFilter({})).toEqual({});
	});

	it('keeps conditions that were passed in', () => {
		// The trigger passes inMailbox in; it must survive.
		expect(buildEmailFilter({ unreadOnly: true }, { inMailbox: 'abc' })).toEqual({
			inMailbox: 'abc',
			notKeyword: '$seen',
		});
	});

	it('maps unreadOnly to the absence of the $seen keyword', () => {
		expect(buildEmailFilter({ unreadOnly: true })).toEqual({ notKeyword: '$seen' });
	});

	it('maps flaggedOnly to the presence of the $flagged keyword', () => {
		expect(buildEmailFilter({ flaggedOnly: true })).toEqual({ hasKeyword: '$flagged' });
	});

	it('ignores boolean options that are false', () => {
		expect(buildEmailFilter({ unreadOnly: false, flaggedOnly: false, hasAttachment: false })).toEqual(
			{},
		);
	});

	it('passes address and text conditions through unchanged', () => {
		expect(
			buildEmailFilter({
				from: 'sender@example.com',
				to: 'user+tag@example.com',
				subject: 'invoice',
				text: 'anything',
			}),
		).toEqual({
			from: 'sender@example.com',
			to: 'user+tag@example.com',
			subject: 'invoice',
			text: 'anything',
		});
	});

	it('normalises dates to ISO 8601', () => {
		const filter = buildEmailFilter({ after: '2026-01-02T03:04:05Z' });
		expect(filter.after).toBe('2026-01-02T03:04:05.000Z');
	});

	it('ignores empty strings so an untouched option does not narrow the query', () => {
		// n8n sends '' for string options the user never filled in.
		expect(buildEmailFilter({ from: '', to: '', subject: '', text: '' })).toEqual({});
	});
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The trigger's state machine decides which mail a workflow ever sees. The
 * audit of 1.0.1 showed two ways it could lose a message for good: a batch cap
 * combined with a watermark taken from the newest item, and a strict `>` against
 * an inclusive server-side filter. Both are reproduced here across polls.
 */
vi.mock('../nodes/Jmap/GenericFunctions', async () => {
	const actual = await vi.importActual<any>('../nodes/Jmap/GenericFunctions');
	return {
		...actual,
		getPrimaryAccountId: vi.fn(async () => 'acc'),
		queryEmails: vi.fn(),
		getEmails: vi.fn(),
		updateEmailKeywords: vi.fn(async () => ({})),
	};
});

import { JmapTrigger } from '../nodes/Jmap/JmapTrigger.node';
import * as GF from '../nodes/Jmap/GenericFunctions';

type Mail = { id: string; receivedAt: string };

/** A mailbox that behaves like a JMAP server: inclusive `after`, honours sort, limit and position. */
function mailbox(mails: Mail[]) {
	(GF.queryEmails as any).mockImplementation(
		async (_acc: string, filter: any, sort: any[], limit: number, position = 0) => {
			let hits = mails;
			if (filter.after) {
				const after = new Date(filter.after).getTime();
				// RFC 8621 4.4.1: "the same or after this date-time" — inclusive.
				hits = hits.filter((m) => new Date(m.receivedAt).getTime() >= after);
			}
			const asc = sort[0]?.isAscending !== false;
			hits = [...hits].sort((a, b) => {
				const d = new Date(a.receivedAt).getTime() - new Date(b.receivedAt).getTime();
				return asc ? d : -d;
			});
			return { ids: hits.slice(position, position + limit).map((m) => m.id), total: hits.length };
		},
	);
	(GF.getEmails as any).mockImplementation(async (_acc: string, ids: string[]) =>
		ids.map((id) => mails.find((m) => m.id === id)),
	);
}

function makeCtx(staticData: Record<string, unknown>, options: Record<string, unknown> = {}) {
	return {
		getWorkflowStaticData: () => staticData,
		getNodeParameter: (name: string, fallback?: unknown) => {
			if (name === 'event') return 'newEmail';
			if (name === 'simple') return true;
			if (name === 'options') return options;
			if (name === 'filters') return {};
			return fallback;
		},
		getNode: () => ({ name: 'JMAP Trigger' }),
	};
}

async function poll(ctx: any) {
	const result = await (JmapTrigger.prototype as any).poll.call(ctx);
	return (result?.[0] ?? []).map((i: any) => i.json.id as string);
}

beforeEach(() => vi.clearAllMocks());

describe('trigger does not lose mail', () => {
	it('delivers a message that a later flood pushed out of one batch', async () => {
		const mails: Mail[] = [{ id: 'base', receivedAt: '2026-01-01T10:00:00Z' }];
		mailbox(mails);
		const state: Record<string, unknown> = {};
		const ctx = makeCtx(state, { processBacklogOnFirstRun: true });

		expect(await poll(ctx)).toContain('base');

		// The message that must survive, then more later ones than a single poll
		// will carry — the cap has to actually bite, or the test proves nothing.
		mails.push({ id: 'TARGET', receivedAt: '2026-01-01T10:00:05Z' });
		for (let i = 0; i < 700; i++) {
			const hour = 11 + Math.floor(i / 60);
			mails.push({
				id: `flood${i}`,
				receivedAt: `2026-01-01T${String(hour).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00Z`,
			});
		}
		mailbox(mails);

		// Drain over several polls; TARGET must appear in one of them.
		const seen: string[] = [];
		for (let i = 0; i < 4; i++) seen.push(...(await poll(ctx)));

		expect(seen).toContain('TARGET');
	});

	it('delivers a second message sharing the watermark timestamp, exactly once', async () => {
		// tie1 lands first and sets the watermark. tie2 carries the SAME
		// receivedAt but only appears afterwards — the case a bare timestamp
		// cannot represent, because it is neither after nor before the mark.
		const mails: Mail[] = [
			{ id: 'a', receivedAt: '2026-01-01T10:00:00Z' },
			{ id: 'tie1', receivedAt: '2026-01-01T10:00:10Z' },
		];
		mailbox(mails);
		const state: Record<string, unknown> = {};
		const ctx = makeCtx(state, { processBacklogOnFirstRun: true });

		const first = await poll(ctx);
		expect(first).toEqual(['a', 'tie1']);

		mails.push({ id: 'tie2', receivedAt: '2026-01-01T10:00:10Z' });
		mailbox(mails);

		// tie2 must arrive, and tie1 must not arrive twice.
		expect(await poll(ctx)).toEqual(['tie2']);
		expect(await poll(ctx)).toEqual([]);
	});

	it('does not redeliver anything when nothing new arrived', async () => {
		const mails: Mail[] = [{ id: 'x', receivedAt: '2026-01-01T10:00:00Z' }];
		mailbox(mails);
		const state: Record<string, unknown> = {};
		const ctx = makeCtx(state, { processBacklogOnFirstRun: true });

		expect(await poll(ctx)).toEqual(['x']);
		expect(await poll(ctx)).toEqual([]);
	});
});

describe('first activation', () => {
	it('emits nothing and starts watching from now by default', async () => {
		mailbox([
			{ id: 'old1', receivedAt: '2026-01-01T09:00:00Z' },
			{ id: 'old2', receivedAt: '2026-01-01T09:30:00Z' },
		]);
		const state: Record<string, unknown> = {};

		expect(await poll(makeCtx(state))).toEqual([]);
		expect(state.lastProcessedTime).toBeTruthy();
	});

	it('emits the backlog when the operator asks for it', async () => {
		mailbox([
			{ id: 'old1', receivedAt: '2026-01-01T09:00:00Z' },
			{ id: 'old2', receivedAt: '2026-01-01T09:30:00Z' },
		]);
		const state: Record<string, unknown> = {};

		expect(await poll(makeCtx(state, { processBacklogOnFirstRun: true }))).toEqual(['old1', 'old2']);
	});
});

describe('markAsRead', () => {
	it('marks delivered mail as read when the option is set', async () => {
		mailbox([{ id: 'm1', receivedAt: '2026-01-01T10:00:00Z' }]);
		const state: Record<string, unknown> = {};

		await poll(makeCtx(state, { processBacklogOnFirstRun: true, markAsRead: true }));

		expect(GF.updateEmailKeywords).toHaveBeenCalledTimes(1);
		expect((GF.updateEmailKeywords as any).mock.calls[0][2]).toMatchObject({ $seen: true });
	});

	it('leaves mail untouched when the option is off', async () => {
		mailbox([{ id: 'm1', receivedAt: '2026-01-01T10:00:00Z' }]);
		const state: Record<string, unknown> = {};

		await poll(makeCtx(state, { processBacklogOnFirstRun: true }));

		expect(GF.updateEmailKeywords).not.toHaveBeenCalled();
	});
});

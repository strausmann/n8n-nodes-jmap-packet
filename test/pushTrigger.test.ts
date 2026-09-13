import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The push trigger's job is narrow: answer the server's verification challenge,
 * and on a state change fetch what actually changed. Everything about which
 * mail counts as new is the same bookkeeping the polling trigger does, so the
 * cases that matter here are the handshake and the refusal to register an
 * unreachable URL.
 */
vi.mock('../nodes/Jmap/GenericFunctions', async () => {
	const actual = await vi.importActual<any>('../nodes/Jmap/GenericFunctions');
	return {
		...actual,
		getPrimaryAccountId: vi.fn(async () => 'acc'),
		getMailboxes: vi.fn(async () => []),
		queryEmails: vi.fn(async () => ({ ids: [], total: 0 })),
		getEmails: vi.fn(async () => []),
		createPushSubscription: vi.fn(async () => 'sub-1'),
		confirmPushSubscription: vi.fn(async () => undefined),
		deletePushSubscription: vi.fn(async () => undefined),
		hasCapability: vi.fn(async () => true),
		updateEmailKeywords: vi.fn(async () => ({})),
	};
});

import { JmapPushTrigger } from '../nodes/Jmap/JmapPushTrigger.node';
import * as GF from '../nodes/Jmap/GenericFunctions';

function hookCtx(webhookUrl: string, staticData: Record<string, unknown> = {}) {
	return {
		getWorkflowStaticData: () => staticData,
		getNodeWebhookUrl: () => webhookUrl,
		getNode: () => ({ name: 'JMAP Push Trigger', id: 'node-1' }),
	};
}

function webhookCtx(body: Record<string, unknown>, staticData: Record<string, unknown> = {}) {
	return {
		getWorkflowStaticData: () => staticData,
		getBodyData: () => body,
		getNode: () => ({ name: 'JMAP Push Trigger', id: 'node-1' }),
		getNodeParameter: (name: string, fallback?: unknown) => {
			if (name === 'simple') return true;
			if (name === 'filters') return {};
			if (name === 'options') return {};
			if (name === 'mailbox') return '';
			return fallback;
		},
	};
}

beforeEach(() => vi.clearAllMocks());

describe('registering the subscription', () => {
	it('refuses a webhook URL the mail server could not use', async () => {
		const node = new JmapPushTrigger();
		const ctx = hookCtx('http://n8n.internal/webhook/abc');

		await expect(node.webhookMethods.default.create.call(ctx as any)).rejects.toThrow(/https/i);
		expect(GF.createPushSubscription).not.toHaveBeenCalled();
	});

	it('registers an https URL and starts watching from now', async () => {
		const node = new JmapPushTrigger();
		const state: Record<string, unknown> = {};
		const ctx = hookCtx('https://workflows.example.com/webhook/abc', state);

		await expect(node.webhookMethods.default.create.call(ctx as any)).resolves.toBe(true);

		expect(GF.createPushSubscription).toHaveBeenCalledTimes(1);
		expect(state.pushSubscriptionId).toBe('sub-1');
		// No backlog: the mailbox as it stands is not "new".
		expect(state.lastProcessedTime).toBeTruthy();
		expect(state.pushVerified).toBe(false);
	});

	it('removes the subscription when the workflow is deactivated', async () => {
		const node = new JmapPushTrigger();
		const state: Record<string, unknown> = { pushSubscriptionId: 'sub-1' };
		const ctx = hookCtx('https://workflows.example.com/webhook/abc', state);

		await node.webhookMethods.default.delete.call(ctx as any);

		expect(GF.deletePushSubscription).toHaveBeenCalledWith('sub-1');
		expect(state.pushSubscriptionId).toBeUndefined();
	});
});

describe('handling what the server posts', () => {
	it('answers the verification challenge and starts no workflow', async () => {
		const node = new JmapPushTrigger();
		const state: Record<string, unknown> = { pushSubscriptionId: 'sub-1' };
		const ctx = webhookCtx(
			{ '@type': 'PushVerification', pushSubscriptionId: 'sub-1', verificationCode: 'code-42' },
			state,
		);

		const result = await node.webhook.call(ctx as any);

		expect(GF.confirmPushSubscription).toHaveBeenCalledWith('sub-1', 'code-42');
		expect(state.pushVerified).toBe(true);
		expect(result.workflowData).toBeUndefined();
	});

	it('ignores a body that is neither a verification nor a state change', async () => {
		const node = new JmapPushTrigger();
		const ctx = webhookCtx({ '@type': 'Something/else' });

		const result = await node.webhook.call(ctx as any);

		expect(result.workflowData).toBeUndefined();
		expect(GF.queryEmails).not.toHaveBeenCalled();
	});

	it('fetches on a state change, because a push never carries the mail', async () => {
		(GF.queryEmails as any).mockResolvedValueOnce({ ids: ['e1'], total: 1 });
		(GF.getEmails as any).mockResolvedValueOnce([
			{ id: 'e1', receivedAt: '2026-01-01T10:00:00Z', subject: 'hello', keywords: {} },
		]);

		const node = new JmapPushTrigger();
		const state: Record<string, unknown> = { lastProcessedTime: '2026-01-01T09:00:00Z' };
		const ctx = webhookCtx({ '@type': 'StateChange', changed: { acc: { Email: 's1' } } }, state);

		const result = await node.webhook.call(ctx as any);

		expect(GF.queryEmails).toHaveBeenCalledTimes(1);
		expect(result.workflowData?.[0]).toHaveLength(1);
		expect(state.lastProcessedTime).toBe('2026-01-01T10:00:00Z');
	});
});

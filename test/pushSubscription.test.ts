import { describe, it, expect } from 'vitest';
import {
	createPushSubscription,
	confirmPushSubscription,
	deletePushSubscription,
	hasCapability,
} from '../nodes/Jmap/GenericFunctions';

const SERVER = 'https://mail.example.com/jmap';

/**
 * Records the JMAP method calls that go out, so a test can assert what was
 * asked of the server rather than only that nothing threw.
 */
function makeContext(responder: (methodCalls: any[]) => any, session?: any) {
	const sent: any[] = [];
	return {
		sent,
		getNode: () => ({ name: 'JMAP', id: 'n1' }),
		getNodeParameter: () => 'jmapPacketBasicAuthApi',
		getCredentials: async () => ({ serverUrl: SERVER }),
		helpers: {
			httpRequestWithAuthentication: async function (_a: string, options: any) {
				if (options.method === 'GET') {
					return (
						session ?? {
							apiUrl: `${SERVER}/`,
							accounts: {},
							primaryAccounts: {},
							capabilities: { 'urn:ietf:params:jmap:core': {}, 'urn:ietf:params:jmap:mail': {} },
						}
					);
				}
				sent.push(options.body);
				return responder(options.body.methodCalls);
			},
		},
	};
}

describe('createPushSubscription', () => {
	it('registers the url and returns the id the server assigned', async () => {
		const ctx = makeContext(() => ({
			methodResponses: [['PushSubscription/set', { created: { sub: { id: 'sub-9' } } }, 'c0']],
		}));

		const id = await createPushSubscription.call(
			ctx as any,
			'https://n8n.example.com/webhook/x',
			'n8n-node-1',
		);

		expect(id).toBe('sub-9');
		const call = ctx.sent[0].methodCalls[0];
		expect(call[0]).toBe('PushSubscription/set');
		expect(call[1].create.sub).toMatchObject({
			url: 'https://n8n.example.com/webhook/x',
			deviceClientId: 'n8n-node-1',
		});
	});

	it('explains itself when the server refuses the subscription', async () => {
		// Servers reject a URL they cannot verify. The message has to say so,
		// otherwise the operator is left with an empty failure.
		const ctx = makeContext(() => ({
			methodResponses: [
				['PushSubscription/set', { notCreated: { sub: { type: 'invalidProperties' } } }, 'c0'],
			],
		}));

		await expect(
			createPushSubscription.call(ctx as any, 'https://n8n.example.com/webhook/x', 'n8n-node-1'),
		).rejects.toThrow(/refused the push subscription/i);
	});
});

describe('confirmPushSubscription', () => {
	it('sends the verification code back for the right subscription', async () => {
		const ctx = makeContext(() => ({
			methodResponses: [['PushSubscription/set', { updated: { 'sub-9': null } }, 'c0']],
		}));

		await confirmPushSubscription.call(ctx as any, 'sub-9', 'code-42');

		const call = ctx.sent[0].methodCalls[0];
		expect(call[1].update['sub-9']).toEqual({ verificationCode: 'code-42' });
	});
});

describe('deletePushSubscription', () => {
	it('destroys the subscription by id', async () => {
		const ctx = makeContext(() => ({
			methodResponses: [['PushSubscription/set', { destroyed: ['sub-9'] }, 'c0']],
		}));

		await deletePushSubscription.call(ctx as any, 'sub-9');

		expect(ctx.sent[0].methodCalls[0][1].destroy).toEqual(['sub-9']);
	});
});

describe('hasCapability', () => {
	it('reports what the session announces, rather than assuming', async () => {
		const ctx = makeContext(() => ({ methodResponses: [] }));

		await expect(hasCapability.call(ctx as any, 'urn:ietf:params:jmap:core')).resolves.toBe(true);
		await expect(hasCapability.call(ctx as any, 'urn:ietf:params:jmap:websocket')).resolves.toBe(
			false,
		);
	});
});

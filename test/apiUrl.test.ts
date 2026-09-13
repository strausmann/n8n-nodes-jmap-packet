import { describe, it, expect } from 'vitest';
import { jmapApiRequest } from '../nodes/Jmap/GenericFunctions';

const SERVER = 'https://mail.example.com/.well-known/jmap';
const API = 'https://mail.example.com/jmap/';

/**
 * Minimal stand-in for n8n's execution context. Records every request so the
 * test can assert *where* the method call went, not just that it succeeded.
 */
function makeContext(session: unknown, opts: { sessionFails?: boolean } = {}) {
	const calls: Array<{ method: string; url: string }> = [];

	const context = {
		calls,
		getNode: () => ({ name: 'JMAP' }),
		getNodeParameter: () => 'jmapPacketBasicAuthApi',
		getCredentials: async () => ({ serverUrl: SERVER }),
		helpers: {
			httpRequestWithAuthentication: async function (_auth: string, options: any) {
				calls.push({ method: options.method, url: options.url });
				if (options.method === 'GET') {
					if (opts.sessionFails) throw new Error('session unreachable');
					return session;
				}
				return { methodResponses: [] };
			},
		},
	};
	return context;
}

describe('jmapApiRequest endpoint resolution', () => {
	it('sends method calls to the apiUrl advertised by the session, not to the configured URL', async () => {
		const ctx = makeContext({ apiUrl: API, accounts: {}, primaryAccounts: {} });

		await jmapApiRequest.call(ctx as any, [['Mailbox/get', {}, 'c0']]);

		const post = ctx.calls.find((c) => c.method === 'POST');
		expect(post?.url).toBe(API);
		// The configured URL is a discovery endpoint — posting there returns 404 on real servers.
		expect(post?.url).not.toBe(SERVER);
	});

	it('resolves a relative apiUrl against the session resource', async () => {
		const ctx = makeContext({ apiUrl: '/jmap/', accounts: {}, primaryAccounts: {} });

		await jmapApiRequest.call(ctx as any, [['Mailbox/get', {}, 'c0']]);

		expect(ctx.calls.find((c) => c.method === 'POST')?.url).toBe(API);
	});

	it('falls back to the configured URL when no session can be resolved', async () => {
		const ctx = makeContext(null, { sessionFails: true });

		await jmapApiRequest.call(ctx as any, [['Mailbox/get', {}, 'c0']]);

		// Existing setups that work today must keep working.
		expect(ctx.calls.find((c) => c.method === 'POST')?.url).toBe(SERVER);
	});

	it('fetches the session only once even across several method calls', async () => {
		const ctx = makeContext({ apiUrl: API, accounts: {}, primaryAccounts: {} });

		await jmapApiRequest.call(ctx as any, [['Mailbox/get', {}, 'c0']]);
		await jmapApiRequest.call(ctx as any, [['Email/query', {}, 'c1']]);

		const sessionCalls = ctx.calls.filter((c) => c.method === 'GET');
		expect(sessionCalls).toHaveLength(1);
	});
});

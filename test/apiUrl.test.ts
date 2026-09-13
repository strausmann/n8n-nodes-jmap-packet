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

describe('jmapApiRequest refuses an off-origin apiUrl', () => {
	// The session tells the client where the next request goes, and that request
	// carries the credential — n8n attaches it to whatever URL it is handed.
	// A server naming a foreign origin would therefore have the credential
	// delivered to it, and could aim the n8n host at addresses only the n8n host
	// can reach. These cases are the reason resolveSameOrigin exists.

	it('falls back to the configured URL when the session names another host', async () => {
		const ctx = makeContext({
			apiUrl: 'https://attacker.example/collect',
			accounts: {},
			primaryAccounts: {},
		});

		await jmapApiRequest.call(ctx as any, [['Core/echo', {}, 'c0']]);

		const post = ctx.calls.find((c) => c.method === 'POST');
		expect(post?.url).not.toContain('attacker.example');
		expect(post?.url).toBe(SERVER);
	});

	it('refuses a protocol-relative apiUrl, which also replaces the host', async () => {
		const ctx = makeContext({
			apiUrl: '//attacker.example/collect',
			accounts: {},
			primaryAccounts: {},
		});

		await jmapApiRequest.call(ctx as any, [['Core/echo', {}, 'c0']]);

		const post = ctx.calls.find((c) => c.method === 'POST');
		expect(post?.url).not.toContain('attacker.example');
		expect(post?.url).toBe(SERVER);
	});

	it('refuses a different scheme on the same host', async () => {
		const ctx = makeContext({
			apiUrl: 'http://mail.example.com/jmap/',
			accounts: {},
			primaryAccounts: {},
		});

		await jmapApiRequest.call(ctx as any, [['Core/echo', {}, 'c0']]);

		const post = ctx.calls.find((c) => c.method === 'POST');
		expect(post?.url).toBe(SERVER);
	});

	it('refuses an apiUrl on a different port of the same host', async () => {
		const ctx = makeContext({
			apiUrl: 'https://mail.example.com:8443/jmap/',
			accounts: {},
			primaryAccounts: {},
		});

		await jmapApiRequest.call(ctx as any, [['Core/echo', {}, 'c0']]);

		const post = ctx.calls.find((c) => c.method === 'POST');
		expect(post?.url).toBe(SERVER);
	});

	it('still accepts a same-origin apiUrl on another path — the case the fix exists for', async () => {
		const ctx = makeContext({
			apiUrl: 'https://mail.example.com/jmap/',
			accounts: {},
			primaryAccounts: {},
		});

		await jmapApiRequest.call(ctx as any, [['Core/echo', {}, 'c0']]);

		const post = ctx.calls.find((c) => c.method === 'POST');
		expect(post?.url).toBe('https://mail.example.com/jmap/');
	});
});

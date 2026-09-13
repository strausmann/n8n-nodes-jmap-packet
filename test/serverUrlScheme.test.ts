import { describe, it, expect } from 'vitest';
import { jmapApiRequest } from '../nodes/Jmap/GenericFunctions';

/**
 * Discovery is where the server says where everything else lives. Over plain
 * http that answer is rewritable by anyone on the path — and the credential is
 * readable in transit anyway. Requiring TLS is what gives the origin check its
 * meaning.
 */
function ctxFor(serverUrl: string) {
	return {
		getNode: () => ({ name: 'JMAP' }),
		getNodeParameter: () => 'jmapPacketBasicAuthApi',
		getCredentials: async () => ({ serverUrl }),
		helpers: {
			httpRequestWithAuthentication: async function (_a: string, options: any) {
				if (options.method === 'GET') {
					return { apiUrl: `${serverUrl}/`, accounts: {}, primaryAccounts: {} };
				}
				return { methodResponses: [] };
			},
		},
	};
}

describe('server URL scheme', () => {
	it('refuses a plain http server', async () => {
		await expect(
			jmapApiRequest.call(ctxFor('http://mail.example.com/jmap') as any, [['Core/echo', {}, 'c0']]),
		).rejects.toThrow(/https/i);
	});

	it('accepts https', async () => {
		await expect(
			jmapApiRequest.call(ctxFor('https://mail.example.com/jmap') as any, [['Core/echo', {}, 'c0']]),
		).resolves.toBeDefined();
	});

	it('still allows http on localhost, where development happens', async () => {
		await expect(
			jmapApiRequest.call(ctxFor('http://localhost:8080/jmap') as any, [['Core/echo', {}, 'c0']]),
		).resolves.toBeDefined();
	});

	it('still allows http on 127.0.0.1', async () => {
		await expect(
			jmapApiRequest.call(ctxFor('http://127.0.0.1:8080/jmap') as any, [['Core/echo', {}, 'c0']]),
		).resolves.toBeDefined();
	});
});

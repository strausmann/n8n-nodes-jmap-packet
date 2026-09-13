import { describe, it, expect } from 'vitest';
import { getAttachments } from '../nodes/Jmap/GenericFunctions';

/**
 * Attachment metadata is whatever the JMAP server sends. It is cast, never
 * validated, so a field the spec says is always present may still be missing
 * from a buggy or hostile server — and a missing `type` used to abort the whole
 * run with a raw TypeError instead of a node error.
 */
function makeContext(attachments: unknown[]) {
	return {
		getNode: () => ({ name: 'JMAP' }),
		getNodeParameter: () => 'jmapPacketBasicAuthApi',
		getCredentials: async () => ({ serverUrl: 'https://mail.example.com' }),
		helpers: {
			httpRequestWithAuthentication: async function (_auth: string, options: any) {
				if (options.method === 'GET' && options.url.endsWith('/session')) {
					return {
						apiUrl: 'https://mail.example.com/jmap/',
						downloadUrl: 'https://mail.example.com/dl/{accountId}/{blobId}/{name}?type={type}',
						accounts: { a: {} },
						primaryAccounts: { 'urn:ietf:params:jmap:mail': 'a' },
					};
				}
				if (options.method === 'POST') {
					return {
						methodResponses: [['Email/get', { list: [{ id: 'e1', attachments }] }, 'c0']],
					};
				}
				return new ArrayBuffer(4);
			},
			prepareBinaryData: async (_b: Buffer, name: string, type: string) => ({
				fileName: name,
				mimeType: type,
			}),
		},
	};
}

describe('attachment MIME filter tolerates incomplete server data', () => {
	it('does not throw when an attachment has no type and a filter is set', async () => {
		const ctx = makeContext([{ blobId: 'b1', name: 'x.bin', size: 5 }]);

		await expect(
			getAttachments.call(ctx as any, 'a', 'e1', { mimeTypeFilter: 'application/pdf' }),
		).resolves.toBeDefined();
	});

	it('excludes the typeless attachment rather than smuggling it past the filter', async () => {
		const ctx = makeContext([{ blobId: 'b1', name: 'x.bin', size: 5 }]);

		const result = await getAttachments.call(ctx as any, 'a', 'e1', {
			mimeTypeFilter: 'application/pdf',
		});

		expect(Object.keys(result as object)).toHaveLength(0);
	});

	it('still returns an attachment whose type matches the filter', async () => {
		const ctx = makeContext([
			{ blobId: 'b1', name: 'invoice.pdf', type: 'application/pdf', size: 9 },
		]);

		const result = await getAttachments.call(ctx as any, 'a', 'e1', {
			mimeTypeFilter: 'application/pdf',
		});

		expect(Object.keys(result as object)).toHaveLength(1);
	});
});

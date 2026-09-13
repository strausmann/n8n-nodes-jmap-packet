import type {
	IExecuteFunctions,
	ILoadOptionsFunctions,
	IPollFunctions,
	IHookFunctions,
	IWebhookFunctions,
	IDataObject,
	JsonObject,
	IHttpRequestMethods,
	IHttpRequestOptions,
	INodeExecutionData,
	IBinaryData,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

/**
 * Every n8n context this module can be called from: the action node, option
 * loading, the polling trigger, and the activation hooks and webhook handler of
 * the push trigger. They differ in what else they offer, but all of them can
 * make an authenticated request, which is all this module needs.
 */
export type JmapContext =
	| IExecuteFunctions
	| ILoadOptionsFunctions
	| IPollFunctions
	| IHookFunctions
	| IWebhookFunctions;

export interface IJmapSession {
	accounts: { [key: string]: IJmapAccount };
	primaryAccounts: { [key: string]: string };
	username: string;
	apiUrl: string;
	downloadUrl: string;
	uploadUrl: string;
	eventSourceUrl: string;
	state: string;
	capabilities: { [key: string]: IDataObject };
}

export interface IJmapAccount {
	name: string;
	isPersonal: boolean;
	isReadOnly: boolean;
	accountCapabilities: { [key: string]: IDataObject };
}

export interface IJmapRequest {
	using: string[];
	methodCalls: [string, IDataObject, string][];
}

export interface IJmapResponse {
	methodResponses: [string, IDataObject, string][];
	sessionState: string;
}

// Standard JMAP capabilities
export const JMAP_CAPABILITIES = {
	CORE: 'urn:ietf:params:jmap:core',
	MAIL: 'urn:ietf:params:jmap:mail',
	SUBMISSION: 'urn:ietf:params:jmap:submission',
	VACATION_RESPONSE: 'urn:ietf:params:jmap:vacationresponse',
	JAMES_SHARES: 'urn:apache:james:params:jmap:mail:shares',
	JAMES_QUOTA: 'urn:apache:james:params:jmap:mail:quota',
};

/**
 * Get the authentication type from node parameters
 */
function getAuthType(context: JmapContext): string {
	try {
		return context.getNodeParameter('authentication', 0) as string;
	} catch {
		return 'jmapPacketOAuth2Api'; // Default to OAuth2
	}
}

/**
 * Get JMAP server URL based on credential type
 */
async function getServerUrl(
	context: JmapContext,
): Promise<string> {
	const authType = getAuthType(context);

	let serverUrl: string;

	if (authType === 'jmapPacketOAuth2Api') {
		const credentials = await context.getCredentials('jmapPacketOAuth2Api');
		serverUrl = (credentials.jmapServerUrl as string).replace(/\/$/, '');
	} else {
		// Both jmapPacketBasicAuthApi and jmapPacketBearerTokenApi use 'serverUrl'
		const credentials = await context.getCredentials(authType);
		serverUrl = (credentials.serverUrl as string).replace(/\/$/, '');
	}

	// Checked here because every path to the server runs through this function.
	assertSecureServerUrl(context, serverUrl);

	return serverUrl;
}

/**
 * Make an authenticated JMAP request
 */
async function makeJmapRequest(
	context: JmapContext,
	method: IHttpRequestMethods,
	endpoint: string,
	body?: IDataObject,
): Promise<IDataObject> {
	const authType = getAuthType(context);
	const serverUrl = await getServerUrl(context);
	const url = endpoint.startsWith('http') ? endpoint : `${serverUrl}${endpoint}`;

	const requestOptions: IHttpRequestOptions = {
		method,
		url,
		headers: {
			'Content-Type': 'application/json',
			Accept: 'application/json',
		},
		body,
		json: true,
	};

	const response = await context.helpers.httpRequestWithAuthentication.call(
		context,
		authType,
		requestOptions,
	);
	return response as IDataObject;
}

/**
 * The session is stable for the lifetime of a node execution, so cache it per
 * context object. Without this, resolving apiUrl (see getApiUrl) would add one
 * extra session request to every single method call.
 */
const sessionCache = new WeakMap<object, IJmapSession>();

/**
 * Builds an Email/query filter from the shared option collection used by the
 * Jmap node's "Get Many" operation and by the trigger.
 *
 * Pass any already-known conditions (such as `inMailbox`) in `filter`; they are
 * kept and extended.
 */
export function buildEmailFilter(options: IDataObject, filter: IDataObject = {}): IDataObject {
	// Date filters
	if (options.after) {
		filter.after = new Date(options.after as string).toISOString();
	}
	if (options.before) {
		filter.before = new Date(options.before as string).toISOString();
	}

	// Content filters
	if (options.from) {
		filter.from = options.from;
	}
	if (options.to) {
		filter.to = options.to;
	}
	if (options.subject) {
		filter.subject = options.subject;
	}
	if (options.text) {
		filter.text = options.text;
	}

	// Boolean filters
	if (options.hasAttachment) {
		filter.hasAttachment = true;
	}
	if (options.unreadOnly) {
		filter.notKeyword = '$seen';
	}
	if (options.flaggedOnly) {
		filter.hasKeyword = '$flagged';
	}

	return filter;
}

/**
 * Get JMAP session from the server
 */
export async function getJmapSession(
	this: JmapContext,
): Promise<IJmapSession> {
	const cached = sessionCache.get(this);
	if (cached !== undefined) {
		return cached;
	}

	try {
		const response = await makeJmapRequest(this, 'GET', '/session');
		const session = response as unknown as IJmapSession;
		sessionCache.set(this, session);
		return session;
	} catch (error) {
		if (error instanceof NodeOperationError) throw error;
		throw new NodeApiError(this.getNode(), error as JsonObject, {
			message: 'Failed to get JMAP session',
		});
	}
}

/**
 * Rejects a server URL that would carry the credential in the clear.
 *
 * Discovery is the moment the server gets to say where everything else lives.
 * Over plain HTTP anyone on the path can rewrite that answer, and they can read
 * the credential off the wire while they are at it. Requiring TLS is what makes
 * the origin check above mean anything: without it, the origin is whatever an
 * on-path attacker decides it is.
 *
 * Localhost is exempt. Developing against a local JMAP server over http is
 * normal and carries no on-path attacker worth the name.
 */
function assertSecureServerUrl(
	context: JmapContext,
	serverUrl: string,
): void {
	let parsed: URL;

	try {
		parsed = new URL(serverUrl);
	} catch {
		throw new NodeOperationError(
			context.getNode(),
			`The JMAP server URL is not a valid URL: ${serverUrl}`,
		);
	}

	const isLoopback =
		parsed.hostname === 'localhost' ||
		parsed.hostname === '127.0.0.1' ||
		parsed.hostname === '[::1]' ||
		parsed.hostname === '::1';

	if (parsed.protocol !== 'https:' && !isLoopback) {
		throw new NodeOperationError(
			context.getNode(),
			`The JMAP server URL must use https. Discovery decides where every later request goes, and over ${parsed.protocol}// anyone on the network path can redirect those requests and read your credentials in transit.`,
			{
				description:
					'Use an https URL for the server. Plain http is only accepted for localhost during development.',
			},
		);
	}
}

/**
 * Returns the endpoint that JMAP method calls must be sent to.
 *
 * Per RFC 8620 section 2 the session resource advertises `apiUrl`, and clients
 * are expected to use it for method calls. It is not guaranteed to equal the URL
 * configured in the credential. On Stalwart, for instance, the session lives at
 * `/jmap/session` while `apiUrl` is `/jmap`, so a user who configures the spec's
 * discovery URL (`/.well-known/jmap`) gets a 404 on every method call.
 *
 * Falls back to the configured URL when no session can be resolved.
 *
 * The session is trusted with where to send the next request. That trust is
 * bounded by TLS, enforced in assertSecureServerUrl: over https the answer comes
 * from the server the credential was issued for, and a server that holds the
 * credential anyway gains nothing by redirecting. Guarding the origin on top of
 * that would break the discovery redirect RFC 8620 section 2 provides for, where
 * a domain points at a provider on another host.
 */
async function getApiUrl(
	context: JmapContext,
): Promise<string> {
	const serverUrl = await getServerUrl(context);

	try {
		const session = await getJmapSession.call(context);
		if (session?.apiUrl) {
			// apiUrl may be given relative to the session resource
			return new URL(session.apiUrl, `${serverUrl}/`).toString();
		}
	} catch {
		// Session not reachable — fall through to the configured URL below.
	}

	return serverUrl;
}

/**
 * Make a JMAP API request
 */
export async function jmapApiRequest(
	this: JmapContext,
	methodCalls: [string, IDataObject, string][],
	using: string[] = [JMAP_CAPABILITIES.CORE, JMAP_CAPABILITIES.MAIL],
): Promise<IJmapResponse> {
	const body: IJmapRequest = {
		using,
		methodCalls,
	};

	try {
		const apiUrl = await getApiUrl(this);
		const response = await makeJmapRequest(this, 'POST', apiUrl, body as unknown as IDataObject);
		return response as unknown as IJmapResponse;
	} catch (error) {
		// Our own errors say what is actually wrong — a misconfigured scheme, a
		// refused download target. Wrapping them as an API failure sends the
		// operator looking at the server instead of at the setting.
		if (error instanceof NodeOperationError) throw error;
		throw new NodeApiError(this.getNode(), error as JsonObject, {
			message: 'JMAP API request failed',
		});
	}
}

/**
 * Get the primary account ID for mail
 */
export async function getPrimaryAccountId(
	this: JmapContext,
): Promise<string> {
	const session = await getJmapSession.call(this);
	const mailCapability = JMAP_CAPABILITIES.MAIL;

	if (session.primaryAccounts && session.primaryAccounts[mailCapability]) {
		return session.primaryAccounts[mailCapability];
	}

	const accountIds = Object.keys(session.accounts);
	if (accountIds.length > 0) {
		return accountIds[0];
	}

	throw new NodeOperationError(this.getNode(), 'No JMAP account found');
}

/**
 * Get all mailboxes for an account
 */
export async function getMailboxes(
	this: JmapContext,
	accountId: string,
): Promise<IDataObject[]> {
	const response = await jmapApiRequest.call(
		this,
		[['Mailbox/get', { accountId }, 'c1']],
	);

	const methodResponse = response.methodResponses[0];
	if (methodResponse[0] === 'Mailbox/get') {
		return (methodResponse[1] as IDataObject).list as IDataObject[];
	}

	throw new NodeOperationError(this.getNode(), 'Failed to get mailboxes');
}

/**
 * Find a mailbox by name
 */
export async function findMailboxByName(
	this: JmapContext,
	accountId: string,
	name: string,
): Promise<IDataObject | undefined> {
	const mailboxes = await getMailboxes.call(this, accountId);
	return mailboxes.find((mb) => mb.name === name);
}

/**
 * Find a mailbox by role
 */
export async function findMailboxByRole(
	this: JmapContext,
	accountId: string,
	role: string,
): Promise<IDataObject | undefined> {
	const mailboxes = await getMailboxes.call(this, accountId);
	return mailboxes.find((mb) => mb.role === role);
}

/**
 * Query emails with filters
 */
export async function queryEmails(
	this: JmapContext,
	accountId: string,
	filter: IDataObject = {},
	sort: IDataObject[] = [{ property: 'receivedAt', isAscending: false }],
	limit: number = 50,
	position: number = 0,
): Promise<{ ids: string[]; total: number }> {
	const response = await jmapApiRequest.call(
		this,
		[
			[
				'Email/query',
				{ accountId, filter, sort, limit, position },
				'c1',
			],
		],
	);

	const methodResponse = response.methodResponses[0];
	if (methodResponse[0] === 'Email/query') {
		const result = methodResponse[1] as IDataObject;
		return {
			ids: result.ids as string[],
			total: result.total as number,
		};
	}

	throw new NodeOperationError(this.getNode(), 'Failed to query emails');
}

/**
 * Get emails by IDs
 */
export async function getEmails(
	this: JmapContext,
	accountId: string,
	ids: string[],
	properties: string[] = [
		'id', 'blobId', 'threadId', 'mailboxIds', 'keywords', 'size',
		'receivedAt', 'from', 'to', 'cc', 'bcc', 'replyTo', 'subject',
		'sentAt', 'hasAttachment', 'preview', 'bodyStructure', 'bodyValues',
		'textBody', 'htmlBody', 'attachments',
	],
	fetchTextBodyValues: boolean = true,
	fetchHTMLBodyValues: boolean = true,
): Promise<IDataObject[]> {
	const response = await jmapApiRequest.call(
		this,
		[
			[
				'Email/get',
				{
					accountId,
					ids,
					properties,
					fetchTextBodyValues,
					fetchHTMLBodyValues,
					maxBodyValueBytes: 1048576,
				},
				'c1',
			],
		],
	);

	const methodResponse = response.methodResponses[0];
	if (methodResponse[0] === 'Email/get') {
		return (methodResponse[1] as IDataObject).list as IDataObject[];
	}

	throw new NodeOperationError(this.getNode(), 'Failed to get emails');
}

/**
 * Create and send an email
 */
export async function sendEmail(
	this: IExecuteFunctions,
	accountId: string,
	email: IDataObject,
	identityId: string,
): Promise<IDataObject> {
	const draftsMailbox = await findMailboxByRole.call(this, accountId, 'drafts');
	if (!draftsMailbox) {
		throw new NodeOperationError(this.getNode(), 'Drafts mailbox not found');
	}

	const emailCreate = {
		...email,
		mailboxIds: { [draftsMailbox.id as string]: true },
		keywords: { $draft: true },
	};

	const response = await jmapApiRequest.call(
		this,
		[
			['Email/set', { accountId, create: { draft: emailCreate } }, 'c1'],
			[
				'EmailSubmission/set',
				{
					accountId,
					create: { send: { emailId: '#draft', identityId } },
					onSuccessDestroyEmail: ['#send'],
				},
				'c2',
			],
		],
		[JMAP_CAPABILITIES.CORE, JMAP_CAPABILITIES.MAIL, JMAP_CAPABILITIES.SUBMISSION],
	);

	for (const methodResponse of response.methodResponses) {
		if (methodResponse[0] === 'error') {
			throw new NodeOperationError(this.getNode(), `JMAP error: ${JSON.stringify(methodResponse[1])}`);
		}
	}

	return response.methodResponses[1][1] as IDataObject;
}

/**
 * Create a draft email
 */
export async function createDraft(
	this: IExecuteFunctions,
	accountId: string,
	email: IDataObject,
): Promise<IDataObject> {
	const draftsMailbox = await findMailboxByRole.call(this, accountId, 'drafts');
	if (!draftsMailbox) {
		throw new NodeOperationError(this.getNode(), 'Drafts mailbox not found');
	}

	const emailCreate = {
		...email,
		mailboxIds: { [draftsMailbox.id as string]: true },
		keywords: { $draft: true },
	};

	const response = await jmapApiRequest.call(
		this,
		[['Email/set', { accountId, create: { draft: emailCreate } }, 'c1']],
	);

	const methodResponse = response.methodResponses[0];
	if (methodResponse[0] === 'error') {
		throw new NodeOperationError(this.getNode(), `JMAP error: ${JSON.stringify(methodResponse[1])}`);
	}

	if (methodResponse[0] === 'Email/set') {
		const result = methodResponse[1] as IDataObject;
		const created = result.created as IDataObject;
		if (created && created.draft) {
			return created.draft as IDataObject;
		}
	}

	return methodResponse[1] as IDataObject;
}

/**
 * Get identities
 */
export async function getIdentities(
	this: JmapContext,
	accountId: string,
): Promise<IDataObject[]> {
	const response = await jmapApiRequest.call(
		this,
		[['Identity/get', { accountId }, 'c1']],
		[JMAP_CAPABILITIES.CORE, JMAP_CAPABILITIES.SUBMISSION],
	);

	const methodResponse = response.methodResponses[0];
	if (methodResponse[0] === 'Identity/get') {
		return (methodResponse[1] as IDataObject).list as IDataObject[];
	}

	throw new NodeOperationError(this.getNode(), 'Failed to get identities');
}

/**
 * Update email keywords
 */
export async function updateEmailKeywords(
	this: JmapContext,
	accountId: string,
	emailId: string,
	keywords: IDataObject,
): Promise<IDataObject> {
	const response = await jmapApiRequest.call(
		this,
		[['Email/set', { accountId, update: { [emailId]: { keywords } } }, 'c1']],
	);

	const methodResponse = response.methodResponses[0];
	if (methodResponse[0] === 'Email/set') {
		return methodResponse[1] as IDataObject;
	}

	throw new NodeOperationError(this.getNode(), 'Failed to update email');
}

/**
 * Move email to a different mailbox
 */
export async function moveEmail(
	this: IExecuteFunctions,
	accountId: string,
	emailId: string,
	targetMailboxId: string,
): Promise<IDataObject> {
	const response = await jmapApiRequest.call(
		this,
		[
			[
				'Email/set',
				{
					accountId,
					update: { [emailId]: { mailboxIds: { [targetMailboxId]: true } } },
				},
				'c1',
			],
		],
	);

	const methodResponse = response.methodResponses[0];
	if (methodResponse[0] === 'Email/set') {
		return methodResponse[1] as IDataObject;
	}

	throw new NodeOperationError(this.getNode(), 'Failed to move email');
}

/**
 * Add a label (mailbox) to an email
 */
export async function addLabel(
	this: IExecuteFunctions,
	accountId: string,
	emailId: string,
	mailboxId: string,
): Promise<IDataObject> {
	const response = await jmapApiRequest.call(
		this,
		[
			[
				'Email/set',
				{
					accountId,
					update: { [emailId]: { [`mailboxIds/${mailboxId}`]: true } },
				},
				'c1',
			],
		],
	);

	const methodResponse = response.methodResponses[0];
	if (methodResponse[0] === 'Email/set') {
		return methodResponse[1] as IDataObject;
	}

	throw new NodeOperationError(this.getNode(), 'Failed to add label');
}

/**
 * Remove a label (mailbox) from an email
 */
export async function removeLabel(
	this: IExecuteFunctions,
	accountId: string,
	emailId: string,
	mailboxId: string,
): Promise<IDataObject> {
	const response = await jmapApiRequest.call(
		this,
		[
			[
				'Email/set',
				{
					accountId,
					update: { [emailId]: { [`mailboxIds/${mailboxId}`]: null } },
				},
				'c1',
			],
		],
	);

	const methodResponse = response.methodResponses[0];
	if (methodResponse[0] === 'Email/set') {
		return methodResponse[1] as IDataObject;
	}

	throw new NodeOperationError(this.getNode(), 'Failed to remove label');
}

/**
 * Get labels (mailboxes) for an email with their names
 */
export async function getLabels(
	this: IExecuteFunctions,
	accountId: string,
	emailId: string,
): Promise<IDataObject[]> {
	const emails = await getEmails.call(this, accountId, [emailId], ['id', 'mailboxIds']);

	if (emails.length === 0) {
		throw new NodeOperationError(this.getNode(), 'Email not found');
	}

	const email = emails[0];
	const mailboxIds = email.mailboxIds as IDataObject;

	if (!mailboxIds || Object.keys(mailboxIds).length === 0) {
		return [];
	}

	const allMailboxes = await getMailboxes.call(this, accountId);

	const labels: IDataObject[] = [];
	for (const mailboxId of Object.keys(mailboxIds)) {
		const mailbox = allMailboxes.find((mb) => mb.id === mailboxId);
		if (mailbox) {
			labels.push({
				id: mailbox.id,
				name: mailbox.name,
				role: mailbox.role || null,
				totalEmails: mailbox.totalEmails,
				unreadEmails: mailbox.unreadEmails,
			});
		} else {
			labels.push({ id: mailboxId, name: null, role: null });
		}
	}

	return labels;
}

/**
 * Delete emails
 */
export async function deleteEmails(
	this: IExecuteFunctions,
	accountId: string,
	emailIds: string[],
): Promise<IDataObject> {
	const response = await jmapApiRequest.call(
		this,
		[['Email/set', { accountId, destroy: emailIds }, 'c1']],
	);

	const methodResponse = response.methodResponses[0];
	if (methodResponse[0] === 'Email/set') {
		return methodResponse[1] as IDataObject;
	}

	throw new NodeOperationError(this.getNode(), 'Failed to delete emails');
}

/**
 * Get threads
 */
export async function getThreads(
	this: JmapContext,
	accountId: string,
	ids: string[],
): Promise<IDataObject[]> {
	const response = await jmapApiRequest.call(
		this,
		[['Thread/get', { accountId, ids }, 'c1']],
	);

	const methodResponse = response.methodResponses[0];
	if (methodResponse[0] === 'Thread/get') {
		return (methodResponse[1] as IDataObject).list as IDataObject[];
	}

	throw new NodeOperationError(this.getNode(), 'Failed to get threads');
}

/**
 * Download an attachment blob
 */
export async function downloadBlob(
	this: IExecuteFunctions,
	accountId: string,
	blobId: string,
	name: string,
	type: string,
): Promise<Buffer> {
	const session = await getJmapSession.call(this);
	const authType = getAuthType(this);

	// Every placeholder is escaped, including the server-minted ids: an id
	// carrying a slash or a query separator would otherwise reshape the path.
	const filledUrl = session.downloadUrl
		.replace('{accountId}', encodeURIComponent(accountId))
		.replace('{blobId}', encodeURIComponent(blobId))
		.replace('{name}', encodeURIComponent(name))
		.replace('{type}', encodeURIComponent(type));

	const downloadUrl = filledUrl;

	const response = await this.helpers.httpRequestWithAuthentication.call(
		this,
		authType,
		{
			method: 'GET',
			url: downloadUrl,
			encoding: 'arraybuffer',
		} as IHttpRequestOptions,
	);
	return Buffer.from(response as ArrayBuffer);
}

/**
 * Interface for attachment options
 */
export interface IAttachmentOptions {
	includeInline?: boolean;
	mimeTypeFilter?: string;
}

/**
 * Interface for attachment metadata from JMAP
 */
interface IJmapAttachment {
	blobId: string;
	type: string;
	name: string;
	size: number;
	cid?: string;
	isInline?: boolean;
	partId?: string;
}

/**
 * Check if a MIME type matches a filter pattern
 */
function matchesMimeType(mimeType: string | undefined, filter: string): boolean {
	// A server that omits the type gets treated as "does not match" rather than
	// crashing the run. The filter only ever narrows the selection, so failing
	// closed here loses an attachment at worst — it never smuggles one in.
	const normalizedMime = (mimeType ?? '').toLowerCase();
	const normalizedFilter = filter.toLowerCase().trim();

	if (normalizedFilter.endsWith('/*')) {
		const prefix = normalizedFilter.slice(0, -1);
		return normalizedMime.startsWith(prefix);
	}

	return normalizedMime === normalizedFilter;
}

/**
 * Get attachments from an email and return them as binary data.
 * Each attachment is returned as a separate item with binary data in the 'file' field.
 * To extract archives (ZIP, tar.gz), chain with the n8n Compression node.
 */
export async function getAttachments(
	this: IExecuteFunctions,
	accountId: string,
	emailId: string,
	options: IAttachmentOptions = {},
): Promise<INodeExecutionData[]> {
	const { includeInline = false, mimeTypeFilter = '' } = options;

	// Get email with attachments metadata
	const emails = await getEmails.call(this, accountId, [emailId], [
		'id',
		'subject',
		'attachments',
	]);

	if (emails.length === 0) {
		throw new NodeOperationError(this.getNode(), `Email with ID ${emailId} not found`);
	}

	const email = emails[0];
	const attachments = (email.attachments as IJmapAttachment[]) || [];

	if (attachments.length === 0) {
		return [];
	}

	// Parse MIME type filters
	const mimeFilters = mimeTypeFilter
		? mimeTypeFilter.split(',').map((f) => f.trim()).filter((f) => f)
		: [];

	const results: INodeExecutionData[] = [];
	let attachmentIndex = 0;

	for (const attachment of attachments) {
		// Filter by inline status
		// An attachment is considered inline if:
		// - isInline is explicitly true, OR
		// - it has a cid (Content-ID) which is used for inline images in HTML
		const isInlineAttachment = attachment.isInline === true || (attachment.cid !== undefined && attachment.cid !== null);
		if (isInlineAttachment && !includeInline) {
			continue;
		}

		// Filter by MIME type
		if (mimeFilters.length > 0) {
			const matches = mimeFilters.some((filter) => matchesMimeType(attachment.type, filter));
			if (!matches) {
				continue;
			}
		}

		// Download the attachment
		const buffer = await downloadBlob.call(
			this,
			accountId,
			attachment.blobId,
			attachment.name,
			attachment.type,
		);

		// Prepare binary data for n8n
		const binaryData: IBinaryData = await this.helpers.prepareBinaryData(
			buffer,
			attachment.name,
			attachment.type,
		);

		results.push({
			json: {
				emailId: email.id,
				emailSubject: email.subject,
				attachmentIndex,
				fileName: attachment.name,
				mimeType: attachment.type,
				fileSize: attachment.size,
				isInline: isInlineAttachment,
				cid: attachment.cid || null,
			},
			binary: {
				file: binaryData,
			},
		});
		attachmentIndex++;
	}

	return results;
}

/**
 * A push subscription as the server stores it (RFC 8620 section 7.2).
 */
export interface IJmapPushSubscription {
	id: string;
	deviceClientId: string;
	url: string;
	types?: string[];
	verificationCode?: string;
	expires?: string;
}

/**
 * Registers a URL for the server to post state changes to.
 *
 * The subscription is inert until it has been verified: the server posts a
 * PushVerification containing a code, and until that code is sent back nothing
 * else arrives. See confirmPushSubscription.
 */
export async function createPushSubscription(
	this: IHookFunctions,
	url: string,
	deviceClientId: string,
	types: string[] = ['EmailDelivery', 'Email'],
): Promise<string> {
	const response = await jmapApiRequest.call(
		this,
		[
			[
				'PushSubscription/set',
				{
					create: {
						sub: { deviceClientId, url, types },
					},
				},
				'c0',
			],
		],
		[JMAP_CAPABILITIES.CORE],
	);

	const created = (response.methodResponses?.[0]?.[1] as IDataObject)?.created as IDataObject;
	const sub = created?.sub as IDataObject | undefined;

	if (!sub?.id) {
		const notCreated = (response.methodResponses?.[0]?.[1] as IDataObject)?.notCreated;
		throw new NodeOperationError(
			this.getNode(),
			'The JMAP server refused the push subscription.',
			{
				description:
					`Server response: ${JSON.stringify(notCreated ?? response.methodResponses?.[0])}. ` +
					'Servers commonly require the URL to use https with a certificate they can verify, ' +
					'and reject bare IP addresses in favour of a hostname.',
			},
		);
	}

	return sub.id as string;
}

/**
 * Answers the server's verification challenge.
 *
 * Until this succeeds the subscription delivers nothing — the handshake is what
 * proves that whoever registered the URL also controls it.
 */
export async function confirmPushSubscription(
	this: IWebhookFunctions,
	subscriptionId: string,
	verificationCode: string,
): Promise<void> {
	await jmapApiRequest.call(
		this,
		[
			[
				'PushSubscription/set',
				{ update: { [subscriptionId]: { verificationCode } } },
				'c0',
			],
		],
		[JMAP_CAPABILITIES.CORE],
	);
}

/**
 * Removes the subscription. Called when the workflow is deactivated, so the
 * server stops posting to a URL that no longer listens.
 */
export async function deletePushSubscription(
	this: IHookFunctions,
	subscriptionId: string,
): Promise<void> {
	await jmapApiRequest.call(
		this,
		[['PushSubscription/set', { destroy: [subscriptionId] }, 'c0']],
		[JMAP_CAPABILITIES.CORE],
	);
}

/**
 * Whether the server announces support for a capability in its session.
 *
 * Asking beats assuming: the session is where a server states what it can do,
 * and a node that reads it stays honest against the next server.
 */
export async function hasCapability(
	this: JmapContext,
	capability: string,
): Promise<boolean> {
	const session = await getJmapSession.call(this);
	return Object.keys(session.capabilities ?? {}).includes(capability);
}

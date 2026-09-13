import type {
	IHookFunctions,
	IWebhookFunctions,
	IDataObject,
	INodeType,
	INodeTypeDescription,
	IWebhookResponseData,
	ILoadOptionsFunctions,
	INodePropertyOptions,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import {
	getPrimaryAccountId,
	getMailboxes,
	queryEmails,
	getEmails,
	buildEmailFilter,
	createPushSubscription,
	confirmPushSubscription,
	deletePushSubscription,
	hasCapability,
	updateEmailKeywords,
} from './GenericFunctions';

/**
 * Push trigger: the server tells us when something changed.
 *
 * The polling trigger asks every few minutes and is the right default — it
 * needs nothing from the network beyond an outbound connection. This one is for
 * when the delay matters. It registers a URL with the server (RFC 8620 section
 * 7.2), and the server posts there.
 *
 * Two things about that are worth knowing before choosing it:
 *
 * The URL has to be reachable *by the mail server*, over https, with a
 * certificate the server accepts. That is a deployment property, not something
 * a node can arrange. Servers commonly also refuse a bare IP address and want a
 * hostname.
 *
 * And a push says only that something changed, never what. On a StateChange the
 * mail still has to be fetched — the same fetch the polling trigger does, with
 * the same bookkeeping about what was already delivered. Push replaces the
 * clock, not the logic.
 */
export class JmapPushTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'JMAP Push Trigger (Packet)',
		name: 'jmapPushTrigger',
		icon: 'file:jmap.svg',
		group: ['trigger'],
		version: 1,
		description: 'Trigger workflow when the JMAP server reports new mail (server push)',
		defaults: {
			name: 'JMAP Push Trigger',
		},
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'jmapPacketBasicAuthApi',
				required: true,
				displayOptions: { show: { authentication: ['jmapPacketBasicAuthApi'] } },
			},
			{
				name: 'jmapPacketBearerTokenApi',
				required: true,
				displayOptions: { show: { authentication: ['jmapPacketBearerTokenApi'] } },
			},
			{
				name: 'jmapPacketOAuth2Api',
				required: true,
				displayOptions: { show: { authentication: ['jmapPacketOAuth2Api'] } },
			},
		],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: 'webhook',
			},
		],
		properties: [
			{
				displayName: 'Authentication',
				name: 'authentication',
				type: 'options',
				options: [
					{ name: 'Basic Auth', value: 'jmapPacketBasicAuthApi' },
					{ name: 'Bearer Token', value: 'jmapPacketBearerTokenApi' },
					{ name: 'OAuth2', value: 'jmapPacketOAuth2Api' },
				],
				default: 'jmapPacketBasicAuthApi',
				description: 'Authentication method to use',
			},
			{
				displayName: 'Mailbox Name or ID',
				name: 'mailbox',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getMailboxes' },
				default: '',
				description:
					'Only react to mail in this mailbox. Leave empty to watch the whole account. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Simplify',
				name: 'simple',
				type: 'boolean',
				default: true,
				description: 'Whether to return a simplified version of the email data',
			},
			{
				displayName: 'Filters',
				name: 'filters',
				type: 'collection',
				placeholder: 'Add Filter',
				default: {},
				description:
					'Only emit emails matching these conditions. Without a filter every new email is emitted.',
				options: [
					{
						displayName: 'From',
						name: 'from',
						type: 'string',
						default: '',
						description: 'Only emails where the From address contains this text',
					},
					{
						displayName: 'Has Attachment',
						name: 'hasAttachment',
						type: 'boolean',
						default: false,
						description: 'Whether to emit only emails that have attachments',
					},
					{
						displayName: 'Subject',
						name: 'subject',
						type: 'string',
						default: '',
						description: 'Only emails where the subject contains this text',
					},
					{
						displayName: 'To',
						name: 'to',
						type: 'string',
						default: '',
						description:
							'Only emails addressed to this recipient. Useful for sub-addressing — give the full address (e.g. user+invoices@example.com), since matching happens server-side and a bare fragment such as "+invoices" may not match.',
					},
					{
						displayName: 'Unread Only',
						name: 'unreadOnly',
						type: 'boolean',
						default: false,
						description: 'Whether to emit only emails that are still unread',
					},
				],
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Mark as Read',
						name: 'markAsRead',
						type: 'boolean',
						default: false,
						description:
							'Whether to mark the emitted emails as read. Applied after they have been handed to the workflow, so a failure further down leaves them unread.',
					},
				],
			},
		],
	};

	methods = {
		loadOptions: {
			async getMailboxes(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const accountId = await getPrimaryAccountId.call(this);
				const mailboxes = await getMailboxes.call(this, accountId);

				return mailboxes.map((mailbox) => ({
					name: `${mailbox.name} (${mailbox.totalEmails} emails)`,
					value: mailbox.id as string,
				}));
			},
		},
	};

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const staticData = this.getWorkflowStaticData('node');
				return typeof staticData.pushSubscriptionId === 'string';
			},

			async create(this: IHookFunctions): Promise<boolean> {
				const staticData = this.getWorkflowStaticData('node');
				const webhookUrl = this.getNodeWebhookUrl('default') as string;

				if (!webhookUrl?.startsWith('https://')) {
					throw new NodeOperationError(
						this.getNode(),
						'Push needs an https webhook URL that the mail server can reach.',
						{
							description:
								`n8n offers this workflow at ${webhookUrl}. A JMAP server will refuse anything that is not https, and commonly refuses bare IP addresses too. Set N8N_WEBHOOK_URL to a hostname with a certificate the mail server accepts — or use the polling trigger, which needs no inbound reachability at all.`,
						},
					);
				}

				// Ask rather than assume: the session states what the server supports.
				if (!(await hasCapability.call(this, 'urn:ietf:params:jmap:core'))) {
					throw new NodeOperationError(
						this.getNode(),
						'The JMAP server did not announce core capabilities in its session.',
					);
				}

				// Watching from now, not from whatever is already in the mailbox.
				staticData.lastProcessedTime = new Date().toISOString();
				staticData.lastProcessedIds = [];

				const deviceClientId = `n8n-${this.getNode().id ?? 'jmap'}`;
				staticData.pushSubscriptionId = await createPushSubscription.call(
					this,
					webhookUrl,
					deviceClientId,
				);
				staticData.pushVerified = false;

				return true;
			},

			async delete(this: IHookFunctions): Promise<boolean> {
				const staticData = this.getWorkflowStaticData('node');
				const subscriptionId = staticData.pushSubscriptionId as string | undefined;

				if (subscriptionId) {
					try {
						await deletePushSubscription.call(this, subscriptionId);
					} catch {
						// The subscription may already be gone, or the server unreachable.
						// Either way the local state must not keep pointing at it.
					}
				}

				delete staticData.pushSubscriptionId;
				delete staticData.pushVerified;
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const staticData = this.getWorkflowStaticData('node');
		const body = this.getBodyData() as IDataObject;

		// The verification handshake. Until the code is echoed back the
		// subscription delivers nothing, so this is not optional plumbing.
		if (body['@type'] === 'PushVerification') {
			const subscriptionId =
				(body.pushSubscriptionId as string) ?? (staticData.pushSubscriptionId as string);
			const verificationCode = body.verificationCode as string;

			if (subscriptionId && verificationCode) {
				await confirmPushSubscription.call(this, subscriptionId, verificationCode);
				staticData.pushVerified = true;
			}

			// Answer the server, start no workflow: nothing has happened yet.
			return { noWebhookResponse: false, workflowData: undefined };
		}

		if (body['@type'] !== 'StateChange') {
			// Anything else is not ours to act on.
			return { noWebhookResponse: false, workflowData: undefined };
		}

		const simple = this.getNodeParameter('simple') as boolean;
		const filters = this.getNodeParameter('filters', {}) as IDataObject;
		const options = this.getNodeParameter('options', {}) as IDataObject;
		const mailbox = this.getNodeParameter('mailbox', '') as string;

		const accountId = await getPrimaryAccountId.call(this);

		const filter: IDataObject = {};
		if (mailbox) filter.inMailbox = mailbox;
		buildEmailFilter(filters, filter);

		// A push says something changed, never what. The fetch below is the same
		// one the polling trigger does, including the bookkeeping that keeps a
		// timestamp collision from losing or duplicating a message.
		const lastProcessedTime = staticData.lastProcessedTime as string | undefined;
		if (lastProcessedTime) filter.after = lastProcessedTime;

		const { ids } = await queryEmails.call(
			this,
			accountId,
			filter,
			[{ property: 'receivedAt', isAscending: true }],
			100,
		);

		if (ids.length === 0) return { noWebhookResponse: false, workflowData: undefined };

		const properties = [
			'id',
			'threadId',
			'mailboxIds',
			'keywords',
			'receivedAt',
			'from',
			'to',
			'cc',
			'subject',
			'preview',
			'hasAttachment',
		];

		const emails = await getEmails.call(this, accountId, ids, properties, !simple, !simple);
		if (emails.length === 0) return { noWebhookResponse: false, workflowData: undefined };

		const lastProcessedIds = new Set((staticData.lastProcessedIds as string[]) ?? []);
		let newEmails = emails;

		if (lastProcessedTime) {
			const lastTime = new Date(lastProcessedTime).getTime();
			newEmails = emails.filter((email) => {
				const emailTime = new Date(email.receivedAt as string).getTime();
				if (emailTime > lastTime) return true;
				if (emailTime < lastTime) return false;
				return !lastProcessedIds.has(email.id as string);
			});
		}

		if (newEmails.length === 0) return { noWebhookResponse: false, workflowData: undefined };

		const newestDelivered = newEmails[newEmails.length - 1];
		const newWatermark = newestDelivered.receivedAt as string;
		const newWatermarkTime = new Date(newWatermark).getTime();

		const deliveredAtWatermark = newEmails
			.filter((email) => new Date(email.receivedAt as string).getTime() === newWatermarkTime)
			.map((email) => email.id as string);

		const carriedOver =
			lastProcessedTime && new Date(lastProcessedTime).getTime() === newWatermarkTime
				? [...lastProcessedIds]
				: [];

		staticData.lastProcessedTime = newWatermark;
		staticData.lastProcessedIds = [...new Set([...carriedOver, ...deliveredAtWatermark])];

		const returnData = newEmails.map((email) => {
			if (!simple) return { json: email };

			return {
				json: {
					id: email.id,
					threadId: email.threadId,
					from: email.from,
					to: email.to,
					cc: email.cc,
					subject: email.subject,
					preview: email.preview,
					receivedAt: email.receivedAt,
					hasAttachment: email.hasAttachment,
					isRead: !!(email.keywords as IDataObject)?.$seen,
					isFlagged: !!(email.keywords as IDataObject)?.$flagged,
				} as IDataObject,
			};
		});

		if (options.markAsRead) {
			for (const email of newEmails) {
				await updateEmailKeywords.call(this, accountId, email.id as string, {
					...((email.keywords as IDataObject) ?? {}),
					$seen: true,
				});
			}
		}

		return { workflowData: [returnData] };
	}
}

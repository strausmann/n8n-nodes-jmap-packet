import {
	IDataObject,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	IPollFunctions,
} from 'n8n-workflow';

import {
	getPrimaryAccountId,
	getMailboxes,
	queryEmails,
	getEmails,
	buildEmailFilter,
	updateEmailKeywords,
} from './GenericFunctions';

export class JmapTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'JMAP (Packet) Trigger',
		name: 'jmapTrigger',
		icon: 'file:jmap.svg',
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["event"]}}',
		description: 'Trigger workflow on new JMAP emails',
		defaults: {
			name: 'JMAP Trigger',
		},
		inputs: [],
		outputs: ['main'],
		credentials: [
			{
				name: 'jmapPacketBasicAuthApi',
				required: true,
				displayOptions: {
					show: {
						authentication: ['jmapPacketBasicAuthApi'],
					},
				},
			},
			{
				name: 'jmapPacketBearerTokenApi',
				required: true,
				displayOptions: {
					show: {
						authentication: ['jmapPacketBearerTokenApi'],
					},
				},
			},
			{
				name: 'jmapPacketOAuth2Api',
				required: true,
				displayOptions: {
					show: {
						authentication: ['jmapPacketOAuth2Api'],
					},
				},
			},
		],
		polling: true,
		properties: [
			// Authentication selection
			{
				displayName: 'Authentication',
				name: 'authentication',
				type: 'options',
				options: [
					{
						name: 'OAuth2',
						value: 'jmapPacketOAuth2Api',
					},
					{
						name: 'Basic Auth',
						value: 'jmapPacketBasicAuthApi',
					},
					{
						name: 'Bearer Token',
						value: 'jmapPacketBearerTokenApi',
					},
				],
				default: 'jmapPacketOAuth2Api',
				description: 'Authentication method to use',
			},
			{
				displayName: 'Event',
				name: 'event',
				type: 'options',
				options: [
					{
						name: 'New Email',
						value: 'newEmail',
						description: 'Triggers when a new email is received',
					},
					{
						name: 'New Email in Mailbox',
						value: 'newEmailInMailbox',
						description: 'Triggers when a new email is received in a specific mailbox',
					},
				],
				default: 'newEmail',
				required: true,
			},
			{
				displayName: 'Mailbox Name or ID',
				name: 'mailbox',
				type: 'options',
				typeOptions: {
					loadOptionsMethod: 'getMailboxes',
				},
				displayOptions: {
					show: {
						event: ['newEmailInMailbox'],
					},
				},
				default: '',
				description: 'The mailbox to monitor for new emails. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Simplify',
				name: 'simple',
				type: 'boolean',
				default: true,
				description: 'Whether to return a simplified version of the response instead of the raw data',
			},
			{
				displayName: 'Filters',
				name: 'filters',
				type: 'collection',
				placeholder: 'Add Filter',
				default: {},
				description:
					'Only trigger on emails matching these conditions. Without a filter the trigger fires on every new email.',
				options: [
					{
						displayName: 'Flagged Only',
						name: 'flaggedOnly',
						type: 'boolean',
						default: false,
						description: 'Whether to trigger only on flagged/starred emails',
					},
					{
						displayName: 'From Contains',
						name: 'from',
						type: 'string',
						default: '',
						placeholder: 'sender@example.com',
						description: 'Trigger only on emails where the From address contains this text',
					},
					{
						displayName: 'Full Text Search',
						name: 'text',
						type: 'string',
						default: '',
						placeholder: 'search terms',
						description: 'Trigger only on emails matching this text in subject, body or addresses',
					},
					{
						displayName: 'Has Attachment',
						name: 'hasAttachment',
						type: 'boolean',
						default: false,
						description: 'Whether to trigger only on emails that have attachments',
					},
					{
						displayName: 'Subject Contains',
						name: 'subject',
						type: 'string',
						default: '',
						description: 'Trigger only on emails where the subject contains this text',
					},
					{
						displayName: 'To Contains',
						name: 'to',
						type: 'string',
						default: '',
						placeholder: 'user+tag@example.com',
						description:
							'Trigger only on emails addressed to this recipient. Useful for sub-addressing — give the full address (e.g. user+invoices@example.com), since matching happens server-side and a bare fragment such as "+invoices" may not match.',
					},
					{
						displayName: 'Unread Only',
						name: 'unreadOnly',
						type: 'boolean',
						default: false,
						description: 'Whether to trigger only on emails that are still unread',
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
						displayName: 'Include Attachments Info',
						name: 'includeAttachments',
						type: 'boolean',
						default: false,
						description: 'Whether to include attachment information in the output',
					},
					{
						displayName: 'Mark as Read',
						name: 'markAsRead',
						type: 'boolean',
						default: false,
						description:
							'Whether to mark the fetched emails as read. Applied after they have been handed to the workflow, so a failure further down leaves them unread and they are retried.',
					},
					{
						displayName: 'Process Existing Mail on First Activation',
						name: 'processBacklogOnFirstRun',
						type: 'boolean',
						default: false,
						description:
							'Whether the first poll after activation should emit mail that was already in the mailbox. Off by default: the trigger starts watching from the moment it is activated. Turning this on emits the existing backlog as if it had just arrived, which a mutating downstream node will act on for every single message.',
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

	async poll(this: IPollFunctions): Promise<INodeExecutionData[][] | null> {
		const webhookData = this.getWorkflowStaticData('node');
		const event = this.getNodeParameter('event') as string;
		const simple = this.getNodeParameter('simple') as boolean;
		const options = this.getNodeParameter('options') as IDataObject;
		const filters = this.getNodeParameter('filters', {}) as IDataObject;

		// Get the last processed email timestamp
		const lastProcessedTime = webhookData.lastProcessedTime as string | undefined;

		// Get account ID
		const accountId = await getPrimaryAccountId.call(this);

		// Build filter
		const filter: IDataObject = {};

		if (event === 'newEmailInMailbox') {
			const mailbox = this.getNodeParameter('mailbox') as string;
			filter.inMailbox = mailbox;
		}

		// User-defined conditions (From/To/Subject/unread/...)
		buildEmailFilter(filters, filter);

		// First activation: start watching from now unless the operator asked for
		// the backlog.
		//
		// Without this the first poll has no watermark, so it matches everything
		// in the mailbox and emits it as if it had just arrived. Where the trigger
		// feeds something that acts — a reply, a forward, a ticket — that is one
		// action per existing message, in one burst, from a workflow that was
		// merely switched on.
		if (!lastProcessedTime && !options.processBacklogOnFirstRun) {
			const startedWatchingAt = new Date().toISOString();
			webhookData.lastProcessedTime = startedWatchingAt;
			webhookData.lastProcessedIds = [];
			return null;
		}

		// Set last so the poll window always wins over a user-supplied date.
		if (lastProcessedTime) {
			filter.after = lastProcessedTime;
		}

		// Oldest first, and paged.
		//
		// Sorting newest-first and taking a single capped batch loses mail for
		// good: the watermark below is taken from the newest item, so anything
		// that did not fit into the batch ends up *behind* the watermark and can
		// never satisfy the forward filter again. Oldest-first inverts that —
		// whatever is not reached this time simply stays ahead of the watermark
		// and is picked up on the next poll.
		//
		// Paging then lets a backlog drain over a few polls instead of one item
		// per cycle, bounded so a large mailbox cannot stall the poll.
		const PAGE_SIZE = 100;
		const MAX_PER_POLL = 500;

		const ids: string[] = [];
		let position = 0;

		for (;;) {
			const page = await queryEmails.call(
				this,
				accountId,
				filter,
				[{ property: 'receivedAt', isAscending: true }],
				PAGE_SIZE,
				position,
			);

			ids.push(...page.ids);
			position += page.ids.length;

			if (page.ids.length === 0 || position >= page.total) break;
			if (ids.length >= MAX_PER_POLL) break;
		}

		if (ids.length === 0) {
			return null;
		}

		// Get full email data
		let properties = [
			'id',
			'blobId',
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

		if (!simple) {
			properties = [
				...properties,
				'bodyValues',
				'textBody',
				'htmlBody',
				'bodyStructure',
			];
		}

		if (options.includeAttachments) {
			properties.push('attachments');
		}

		const emails = await getEmails.call(
			this,
			accountId,
			ids,
			properties,
			!simple,
			!simple,
		);

		if (emails.length === 0) {
			return null;
		}

		// Drop what was already delivered.
		//
		// A timestamp alone cannot carry this. The server-side `after` filter is
		// inclusive (RFC 8621 section 4.4.1) while a strict `>` here is exclusive,
		// so two messages sharing a receivedAt — ordinary at second resolution,
		// and the norm for bulk delivery — leave the second one discarded on
		// every future poll. The ids seen at the boundary timestamp are therefore
		// remembered alongside it, and only those are skipped.
		const lastProcessedIds = new Set((webhookData.lastProcessedIds as string[]) ?? []);

		let newEmails = emails;
		if (lastProcessedTime) {
			const lastTime = new Date(lastProcessedTime).getTime();
			newEmails = emails.filter((email) => {
				const emailTime = new Date(email.receivedAt as string).getTime();
				if (emailTime > lastTime) return true;
				if (emailTime < lastTime) return false;
				// Same instant as the watermark: deliver unless already delivered.
				return !lastProcessedIds.has(email.id as string);
			});
		}

		if (newEmails.length === 0) {
			return null;
		}

		// The watermark follows what was actually delivered, not what the query
		// happened to return, so an interrupted page cannot carry it past unread
		// mail. Emails are oldest-first, so the last one is the newest delivered.
		const newestDelivered = newEmails[newEmails.length - 1];
		const newWatermark = newestDelivered.receivedAt as string;
		const newWatermarkTime = new Date(newWatermark).getTime();

		const deliveredAtWatermark = newEmails
			.filter((email) => new Date(email.receivedAt as string).getTime() === newWatermarkTime)
			.map((email) => email.id as string);

		// When the watermark has not moved, the ids already remembered for that
		// instant still apply — replacing them would strip their marker and hand
		// them to the workflow a second time on the next poll.
		const carriedOver =
			lastProcessedTime && new Date(lastProcessedTime).getTime() === newWatermarkTime
				? [...lastProcessedIds]
				: [];

		webhookData.lastProcessedTime = newWatermark;
		webhookData.lastProcessedIds = [...new Set([...carriedOver, ...deliveredAtWatermark])];

		// Transform output
		const returnData: INodeExecutionData[] = newEmails.map((email) => {
			let outputEmail: IDataObject;

			if (simple) {
				outputEmail = {
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
				};
			} else {
				outputEmail = email;
			}

			return { json: outputEmail };
		});

		// Marking happens last, on purpose.
		//
		// The option existed in the interface but was never wired to anything:
		// the operator ticked it and nothing happened. Doing it after the items
		// are prepared means a failure while fetching leaves the mail unread, so
		// the next poll sees it again rather than losing it silently.
		if (options.markAsRead) {
			for (const email of newEmails) {
				await updateEmailKeywords.call(this, accountId, email.id as string, {
					...((email.keywords as IDataObject) ?? {}),
					$seen: true,
				});
			}
		}

		return [returnData];
	}
}

import GLib from 'gi://GLib';
import Soup from 'gi://Soup';
import Xmlb from 'gi://Xmlb';

import { ImapClient } from './imap.js';

async function deleteMessageOAuth2(url, method, { goaObject, cancellable, httpSession }) {
    const oauth2 = goaObject.get_oauth2_based();
    const [token] = await oauth2.call_get_access_token(cancellable);

    const request = Soup.Message.new(method, url);
    request.request_headers.append('Authorization', `Bearer ${token}`);

    const bytes = await httpSession.send_and_read_async(
        request,
        GLib.PRIORITY_DEFAULT,
        cancellable,
    );

    const status = request.get_status();
    // 204 No Content is success for DELETE; 200 OK for other mutations
    if (status < 200 || status >= 300) {
        let detail = request.get_reason_phrase();
        try {
            const body = new TextDecoder('utf-8').decode(bytes.get_data());
            if (body) detail = `${detail}: ${body}`;
        } catch {
            // ignore decode errors
        }
        throw new Error(`HTTP ${status}: ${detail}`);
    }
}

async function fetchMessagesOAuth2(
    provider,
    { goaObject, cancellable, httpSession, settings, mailbox },
) {
    const oauth2 = goaObject.get_oauth2_based();
    const [token] = await oauth2.call_get_access_token(cancellable);

    const priorityOnly = settings.get_boolean('priority-only');
    const url = provider.getApiURL(priorityOnly);

    const request = Soup.Message.new('GET', url);
    request.request_headers.append('Authorization', `Bearer ${token}`);

    const bytes = await httpSession.send_and_read_async(
        request,
        GLib.PRIORITY_DEFAULT,
        cancellable,
    );

    const status = request.get_status();
    if (status !== 200) throw new Error(`HTTP ${status}: ${request.get_reason_phrase()}`);

    const body = new TextDecoder('utf-8').decode(bytes.get_data());
    return provider.parseResponse(body, mailbox);
}

const googleProvider = {
    fetchMessages(params) {
        return fetchMessagesOAuth2(this, params);
    },

    // GOA's Google token includes https://mail.google.com/ for IMAP/SMTP, but
    // gmail.googleapis.com REST calls often return HTTP 403 for that client.
    // Delete via IMAP XOAUTH2 using X-GM-MSGID (same decimal id as the Atom feed).
    async deleteMessage({ goaObject, cancellable, logger, message }) {
        const mail = goaObject.get_mail();
        if (!mail) throw new Error('Google account does not have Mail interface');
        if (!mail.imap_host) throw new Error('Google account is missing imap_host');

        const oauth2 = goaObject.get_oauth2_based();
        if (!oauth2) throw new Error('Google account does not support OAuth2');

        const [token] = await oauth2.call_get_access_token(cancellable);
        const gmMsgid = this._atomIdToGmMsgid(message.id);
        const username = mail.imap_user_name || mail.email_address;

        const useStartTls = !mail.imap_use_ssl && mail.imap_use_tls;
        const defaultPort = useStartTls ? 143 : 993;
        const [host, portStr] = mail.imap_host.split(':');
        const port = portStr ? parseInt(portStr, 10) : defaultPort;

        const client = new ImapClient({
            host,
            port,
            username,
            oauth2Token: token,
            useStartTls,
            cancellable,
            logger,
        });

        try {
            await client.connect();
            await client.selectMailbox('INBOX');
            const uid = await client.searchGmMsgid(gmMsgid);
            if (!uid) throw new Error('Message not found in IMAP inbox');
            await client.deleteMessage(uid);
        } finally {
            await client.logout();
        }
    },

    _atomIdToGmMsgid(atomId) {
        // Atom IDs look like: tag:gmail.google.com,2004:<decimal>
        // That decimal is Gmail's X-GM-MSGID (see Gmail IMAP extensions).
        const match = String(atomId).match(/:(\d+)$/);
        if (!match) throw new Error('Unrecognized Gmail message id');
        return match[1];
    },

    getApiURL(priorityOnly) {
        const label = priorityOnly ? '%5Eiim' : '%5Ei';
        return `https://mail.google.com/mail/feed/atom/${label}`;
    },

    getInboxURL(mailbox) {
        return `https://mail.google.com/mail/u/${mailbox}`;
    },

    parseResponse(body, mailbox) {
        const xml = body.replace(/xmlns="[^"]*"/g, '');

        const builder = new Xmlb.Builder();
        const source = new Xmlb.BuilderSource();
        source.load_xml(xml, Xmlb.BuilderSourceFlags.NONE);
        builder.import_source(source);
        const silo = builder.compile(Xmlb.BuilderCompileFlags.NONE, null);

        let entries;
        try {
            entries = silo.query('feed/entry', null);
        } catch {
            return [];
        }

        return entries.map((entry) => {
            const text = (xpath) => {
                try {
                    return entry.query_text(xpath);
                } catch {
                    return null;
                }
            };
            const href = entry.query_attr('link', 'href');
            return {
                id: text('id'),
                subject: text('title'),
                from: `${text('author/name') || ''} <${text('author/email') || ''}>`,
                link: href
                    ? href.replace(
                          'https://mail.google.com/mail',
                          `https://mail.google.com/mail/u/${mailbox}`,
                      )
                    : this.getInboxURL(mailbox),
            };
        });
    },
};

const microsoftProvider = {
    fetchMessages(params) {
        return fetchMessagesOAuth2(this, params);
    },

    deleteMessage(params) {
        const url = `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(params.message.id)}`;
        return deleteMessageOAuth2(url, 'DELETE', params);
    },

    getInboxURL() {
        return 'https://outlook.live.com';
    },

    getApiURL(priorityOnly) {
        const filter = priorityOnly
            ? "isRead eq false and inferenceClassification eq 'focused'"
            : 'isRead eq false';
        return `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$filter=${filter}&$select=from,subject,webLink,id`;
    },

    parseResponse(body) {
        const data = JSON.parse(body);
        return (data.value || []).map((msg) => {
            const addr = msg.from?.emailAddress;
            return {
                id: msg.id,
                subject: msg.subject,
                from: addr ? `${addr.name} <${addr.address}>` : '',
                link: msg.webLink || this.getInboxURL(),
            };
        });
    },
};

const imapProvider = {
    getInboxURL() {
        return null;
    },

    async _withClient({ goaObject, cancellable, logger }, fn) {
        const mail = goaObject.get_mail();
        if (!mail) throw new Error('IMAP account does not have Mail interface');
        if (!mail.imap_host) throw new Error('IMAP account is missing imap_host configuration');
        if (!mail.imap_use_ssl && !mail.imap_use_tls)
            throw new Error('IMAP requires SSL/TLS or STARTTLS');

        const useStartTls = !mail.imap_use_ssl && mail.imap_use_tls;
        const defaultPort = useStartTls ? 143 : 993;
        const [host, portStr] = mail.imap_host.split(':');
        const port = portStr ? parseInt(portStr, 10) : defaultPort;
        const username = mail.imap_user_name || mail.email_address;

        const passwordBased = goaObject.get_password_based();
        if (!passwordBased) throw new Error('IMAP account does not have password');

        const [password] = await passwordBased.call_get_password('imap-password', cancellable);

        const client = new ImapClient({
            host,
            port,
            username,
            password,
            useStartTls,
            cancellable,
            logger,
        });

        try {
            await client.connect();
            await client.selectMailbox('INBOX');
            return await fn(client);
        } finally {
            await client.logout();
        }
    },

    fetchMessages(params) {
        return this._withClient(params, async (client) => {
            const unreadIds = await client.searchUnread();
            return client.fetchMessages(unreadIds);
        });
    },

    deleteMessage(params) {
        const uid = params.message.uid;
        if (!uid) throw new Error('IMAP message is missing uid');

        return this._withClient(params, async (client) => {
            await client.deleteMessage(uid);
        });
    },
};

export const providers = {
    google: googleProvider,
    ms_graph: microsoftProvider,
    imap_smtp: imapProvider,
};

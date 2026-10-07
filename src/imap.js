import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export class ImapClient {
    constructor({
        host,
        port,
        username,
        password = null,
        oauth2Token = null,
        useStartTls = false,
        timeoutSeconds = 30,
        cancellable,
        logger,
    }) {
        this._host = host;
        this._port = port;
        this._username = username;
        this._password = password;
        this._oauth2Token = oauth2Token;
        this._useStartTls = useStartTls;
        this._cancellable = cancellable;
        this._logger = logger;
        this._timeoutSeconds = timeoutSeconds;
        this._connection = null;
        this._input = null;
        this._output = null;
        this._commandId = 0;
        this._buffer = '';
    }

    async connect() {
        const client = new Gio.SocketClient();
        // Gmail IMAP (esp. LIST / MOVE) routinely needs more than 10s.
        client.set_timeout(this._timeoutSeconds);

        this._connection = await client.connect_to_host_async(
            `${this._host}:${this._port}`,
            this._port,
            this._cancellable,
        );

        if (!this._useStartTls) {
            await this._handshakeTls();
        }

        this._input = this._connection.get_input_stream();
        this._output = this._connection.get_output_stream();

        await this._readResponse();

        if (this._useStartTls) {
            await this._upgradeToTls();
        }

        await this._login();
    }

    async _handshakeTls() {
        const identity = Gio.NetworkAddress.new(this._host, this._port);
        const tlsConnection = Gio.TlsClientConnection.new(this._connection, identity);
        // Accept self-signed certificates for localhost (e.g. ProtonMail Bridge)
        if (this._host === '127.0.0.1' || this._host === 'localhost') {
            tlsConnection.connect('accept-certificate', () => true);
        }
        await tlsConnection.handshake_async(GLib.PRIORITY_DEFAULT, this._cancellable);
        this._connection = tlsConnection;
    }

    async _upgradeToTls() {
        const response = await this._sendCommand('STARTTLS');
        if (!response.includes('OK')) {
            throw new Error('STARTTLS failed');
        }
        await this._handshakeTls();
        this._input = this._connection.get_input_stream();
        this._output = this._connection.get_output_stream();
    }

    _quoteString(str) {
        return '"' + str.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    }

    async _login() {
        if (this._oauth2Token) {
            await this._authenticateXOAuth2();
            return;
        }

        if (!this._password) {
            throw new Error('IMAP password is missing');
        }

        const user = this._quoteString(this._username);
        const pass = this._quoteString(this._password);
        const response = await this._sendCommand('LOGIN', `${user} ${pass}`);
        if (!response.includes('OK')) {
            throw new Error('IMAP login failed');
        }
    }

    async _authenticateXOAuth2() {
        // SASL XOAUTH2 initial client response (RFC 7628 / Google IMAP)
        const raw = `user=${this._username}\x01auth=Bearer ${this._oauth2Token}\x01\x01`;
        const encoded = GLib.base64_encode(new TextEncoder().encode(raw));

        this._commandId++;
        const tag = `A${this._commandId.toString().padStart(4, '0')}`;
        const cmd = `${tag} AUTHENTICATE XOAUTH2 ${encoded}\r\n`;
        const bytes = new GLib.Bytes(new TextEncoder().encode(cmd));
        await this._output.write_bytes_async(bytes, GLib.PRIORITY_DEFAULT, this._cancellable);

        let response = await this._readUntil(new RegExp(`^\\+|${tag} (OK|NO|BAD)`, 'm'));

        // On auth failure Gmail sends a "+" challenge; cancel with an empty line.
        if (/^\+/m.test(response) && !new RegExp(`${tag} (OK|NO|BAD)`).test(response)) {
            const empty = new GLib.Bytes(new TextEncoder().encode('\r\n'));
            await this._output.write_bytes_async(
                empty,
                GLib.PRIORITY_DEFAULT,
                this._cancellable,
            );
            response += await this._readUntil(new RegExp(`${tag} (OK|NO|BAD)`));
        }

        if (!response.includes(`${tag} OK`)) {
            throw new Error('IMAP XOAUTH2 authentication failed');
        }
    }

    async _readUntil(terminator) {
        while (true) {
            // eslint-disable-next-line no-await-in-loop -- sequential socket reads
            const bytes = await this._input.read_bytes_async(
                4096,
                GLib.PRIORITY_DEFAULT,
                this._cancellable,
            );

            if (bytes.get_size() === 0) break;

            this._buffer += new TextDecoder('utf-8').decode(bytes.get_data());

            if (terminator.test(this._buffer)) {
                const result = this._buffer;
                this._buffer = '';
                return result;
            }
        }

        return this._buffer;
    }

    async selectMailbox(mailbox = 'INBOX') {
        const response = await this._sendCommand('SELECT', this._quoteMailbox(mailbox));
        if (!response.includes('OK')) {
            throw new Error(`Failed to select mailbox: ${mailbox}`);
        }
    }

    async searchUnread() {
        const response = await this._sendCommand('SEARCH', 'UNSEEN');
        const match = response.match(/\* SEARCH (.+)/);

        if (!match || !match[1].trim()) {
            return [];
        }

        return match[1]
            .trim()
            .split(' ')
            .filter((id) => id);
    }

    async searchGmMsgid(gmMsgid) {
        const response = await this._sendCommand('UID SEARCH', `X-GM-MSGID ${gmMsgid}`);
        const match = response.match(/\* SEARCH (.+)/);
        if (!match || !match[1].trim()) {
            return null;
        }

        return match[1].trim().split(/\s+/)[0];
    }

    /**
     * Find a Gmail message by X-GM-MSGID, trying INBOX then All Mail.
     * Returns { uid, mailbox } or null.
     */
    async findGmMsgid(gmMsgid) {
        const mailboxes = ['INBOX', '[Gmail]/All Mail', '[Google Mail]/All Mail'];
        for (const mailbox of mailboxes) {
            try {
                // eslint-disable-next-line no-await-in-loop -- try mailboxes sequentially
                await this.selectMailbox(mailbox);
            } catch {
                continue;
            }

            // eslint-disable-next-line no-await-in-loop -- try mailboxes sequentially
            const uid = await this.searchGmMsgid(gmMsgid);
            if (uid) return { uid, mailbox };
        }
        return null;
    }

    async fetchMessages(messageIds, limit = 10) {
        if (messageIds.length === 0) {
            return [];
        }

        const limited = messageIds.slice(-limit);
        const idRange = limited.join(',');
        const response = await this._sendCommand(
            'FETCH',
            `${idRange} (UID BODY.PEEK[HEADER.FIELDS (FROM SUBJECT MESSAGE-ID)])`,
        );

        return this._parseMessages(response);
    }

    async deleteMessage(uid) {
        // Fast path for Gmail: add \Trash label (avoids LIST of every folder).
        if (this._oauth2Token) {
            const labelResponse = await this._sendCommand(
                'UID STORE',
                `${uid} +X-GM-LABELS (\\Trash)`,
            );
            if (labelResponse.includes('OK')) return;

            // Fall back to moving into Gmail's trash mailbox only.
            for (const trashFolder of ['[Gmail]/Trash', '[Google Mail]/Trash']) {
                // eslint-disable-next-line no-await-in-loop -- try known Gmail trash names
                const moveResponse = await this._sendCommand(
                    'UID MOVE',
                    `${uid} ${this._quoteMailbox(trashFolder)}`,
                );
                if (moveResponse.includes('OK')) return;
            }

            await this._expungeUid(uid);
            return;
        }

        // Generic IMAP: try common trash mailboxes, then a narrow LIST.
        for (const trashFolder of this._candidateTrashFolders()) {
            // eslint-disable-next-line no-await-in-loop -- try candidates sequentially
            const moveResponse = await this._sendCommand(
                'UID MOVE',
                `${uid} ${this._quoteMailbox(trashFolder)}`,
            );
            if (moveResponse.includes('OK')) return;

            // eslint-disable-next-line no-await-in-loop -- try candidates sequentially
            const copyResponse = await this._sendCommand(
                'UID COPY',
                `${uid} ${this._quoteMailbox(trashFolder)}`,
            );
            if (copyResponse.includes('OK')) {
                await this._expungeUid(uid);
                return;
            }
        }

        const listResponse = await this._sendCommand('LIST', '"" "*Trash*"');
        const trashFolder = this._findTrashFolder(listResponse);
        if (trashFolder) {
            const moveResponse = await this._sendCommand(
                'UID MOVE',
                `${uid} ${this._quoteMailbox(trashFolder)}`,
            );
            if (moveResponse.includes('OK')) return;
        }

        await this._expungeUid(uid);
    }

    async _expungeUid(uid) {
        const storeResponse = await this._sendCommand('UID STORE', `${uid} +FLAGS (\\Deleted)`);
        if (!storeResponse.includes('OK')) {
            throw new Error('Failed to mark message as deleted');
        }

        const expungeResponse = await this._sendCommand('UID EXPUNGE', String(uid));
        if (expungeResponse.includes('OK')) return;

        const fallback = await this._sendCommand('EXPUNGE');
        if (!fallback.includes('OK')) {
            throw new Error('Failed to expunge deleted message');
        }
    }

    _quoteMailbox(name) {
        if (name.startsWith('"')) return name;
        return `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    }

    _candidateTrashFolders() {
        return [
            '[Gmail]/Trash',
            '[Google Mail]/Trash',
            'Trash',
            'Deleted Items',
            'INBOX.Trash',
            'Deleted',
        ];
    }

    _findTrashFolder(listResponse) {
        const names = [];
        for (const line of listResponse.split('\r\n')) {
            const match = line.match(/^\* LIST \(.*\) (?:NIL|"[^"]*") (.+)$/);
            if (!match) continue;

            let name = match[1].trim();
            if (name.startsWith('"') && name.endsWith('"')) {
                name = name.slice(1, -1);
            }
            names.push(name);
        }

        for (const candidate of this._candidateTrashFolders()) {
            const found = names.find((n) => n.toLowerCase() === candidate.toLowerCase());
            if (found) return found;
        }

        return names.find((n) => /trash|deleted/i.test(n)) || null;
    }

    async logout() {
        try {
            await this._sendCommand('LOGOUT');
        } catch (err) {
            this._logger?.log(`IMAP logout error: ${err.message}`);
        } finally {
            this._connection?.close(null);
            this._connection = null;
        }
    }

    async _sendCommand(command, args = '') {
        this._commandId++;
        const tag = `A${this._commandId.toString().padStart(4, '0')}`;
        const cmd = args ? `${tag} ${command} ${args}\r\n` : `${tag} ${command}\r\n`;

        const bytes = new GLib.Bytes(new TextEncoder().encode(cmd));
        await this._output.write_bytes_async(bytes, GLib.PRIORITY_DEFAULT, this._cancellable);

        return this._readResponse(tag);
    }

    async _readResponse(tag = null) {
        const terminator = tag ? new RegExp(`${tag} (OK|NO|BAD)`) : /\r\n/;

        while (true) {
            // eslint-disable-next-line no-await-in-loop -- sequential socket reads, each chunk depends on the previous one
            const bytes = await this._input.read_bytes_async(
                4096,
                GLib.PRIORITY_DEFAULT,
                this._cancellable,
            );

            if (bytes.get_size() === 0) break;

            this._buffer += new TextDecoder('utf-8').decode(bytes.get_data());

            if (terminator.test(this._buffer)) {
                const result = this._buffer;
                this._buffer = '';
                return result;
            }
        }

        return this._buffer;
    }

    _parseMessages(response) {
        return response
            .split(/(?=\* \d+ FETCH)/)
            .filter((block) => block.startsWith('* '))
            .map((block) => {
                const uidMatch = block.match(/UID (\d+)/);
                const seqMatch = block.match(/\* (\d+) FETCH/);
                return this._parseHeaders(uidMatch?.[1] || seqMatch[1], block);
            });
    }

    _unfoldHeaders(raw) {
        return raw.replace(/\r?\n[ \t]/g, ' ');
    }

    _decodeMimeWord(encoded) {
        try {
            const match = encoded.match(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/);
            if (!match) return encoded;

            const [, charset, encoding, data] = match;

            if (encoding.toUpperCase() === 'B') {
                const bytes = GLib.base64_decode(data);
                return new TextDecoder(charset).decode(bytes);
            }

            if (encoding.toUpperCase() === 'Q') {
                const decoded = data
                    .replace(/_/g, ' ')
                    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) =>
                        String.fromCharCode(parseInt(hex, 16)),
                    );
                return new TextDecoder(charset).decode(
                    Uint8Array.from(decoded, (c) => c.charCodeAt(0)),
                );
            }

            return encoded;
        } catch {
            return encoded;
        }
    }

    _decodeMime(str) {
        if (!str) return str;
        return str
            .replace(/\?=\s+=\?/g, '?==?')
            .replace(/=\?[^?]+\?[BbQq]\?[^?]*\?=/g, (match) => this._decodeMimeWord(match));
    }

    _parseHeaders(uid, headers) {
        const unfolded = this._unfoldHeaders(headers);
        const fromMatch = unfolded.match(/From: (.+)/i);
        const subjectMatch = unfolded.match(/Subject: (.+)/i);
        const messageIdMatch = unfolded.match(/Message-ID: <(.+?)>/i);

        return {
            id: messageIdMatch ? messageIdMatch[1] : `uid_${uid}`,
            uid,
            subject: subjectMatch ? this._decodeMime(subjectMatch[1].trim()) : null,
            from: this._decodeMime(fromMatch ? fromMatch[1].trim() : '(Unknown sender)'),
            link: null,
        };
    }
}

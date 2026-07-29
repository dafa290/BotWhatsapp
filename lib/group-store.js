const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(process.cwd(), '.wa_group_cache.json');
const MAX_MESSAGES_PER_GROUP = 500;

function loadCache() {
    try {
        if (!fs.existsSync(CACHE_FILE)) return {};
        return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
    } catch {
        return {};
    }
}

function saveCache(data) {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

function extractSenderName(msg) {
    return msg.pushName || msg.key.participant?.split('@')[0] || 'Unknown';
}

function extractMessageText(msg) {
    const m = msg.message;
    if (!m) return '';
    return (
        m.conversation ||
        m.extendedTextMessage?.text ||
        m.imageMessage?.caption ||
        m.videoMessage?.caption ||
        ''
    ).trim();
}

function storeGroupMessage(msg) {
    const jid = msg.key.remoteJid;
    if (!jid || !jid.endsWith('@g.us')) return;

    const text = extractMessageText(msg);
    if (!text) return;

    const cache = loadCache();
    if (!cache[jid]) cache[jid] = [];

    cache[jid].push({
        from: extractSenderName(msg),
        text: text.slice(0, 500),
        at: new Date().toISOString(),
    });

    if (cache[jid].length > MAX_MESSAGES_PER_GROUP) {
        cache[jid] = cache[jid].slice(-MAX_MESSAGES_PER_GROUP);
    }

    saveCache(cache);
}

function getGroupMessages(jid, limit = 100) {
    const cache = loadCache();
    const messages = cache[jid] || [];
    return messages.slice(-limit);
}

function formatForSummary(messages) {
    return messages.map((m) => {
        const time = new Date(m.at).toLocaleString('id-ID', { hour: '2-digit', minute: '2-digit' });
        return `[${time}] ${m.from}: ${m.text}`;
    }).join('\n');
}

module.exports = { storeGroupMessage, getGroupMessages, formatForSummary };

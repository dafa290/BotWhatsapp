const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

const REMINDERS_FILE = path.join(process.cwd(), '.wa_reminders.json');

function loadReminders() {
    try {
        if (!fs.existsSync(REMINDERS_FILE)) return [];
        return JSON.parse(fs.readFileSync(REMINDERS_FILE, 'utf-8'));
    } catch {
        return [];
    }
}

function saveReminders(list) {
    fs.writeFileSync(REMINDERS_FILE, JSON.stringify(list, null, 2), 'utf-8');
}

function parseReminderInput(text) {
    // Format: /ingatkan 20:00 submit tugas
    // Format: /ingatkan besok 08:00 meeting
    // Format: /ingatkan 2026-07-20 20:00 bayar listrik
    const trimmed = text.trim();
    const match = trimmed.match(
        /^(\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}|besok\s+\d{1,2}:\d{2}|\d{1,2}:\d{2})\s+(.+)$/i
    );
    if (!match) return null;

    const timePart = match[1].toLowerCase();
    const message = match[2].trim();
    const now = new Date();

    let fireAt;

    if (/^\d{1,2}:\d{2}$/.test(timePart)) {
        const [h, m] = timePart.split(':').map(Number);
        fireAt = new Date(now);
        fireAt.setHours(h, m, 0, 0);
        if (fireAt <= now) fireAt.setDate(fireAt.getDate() + 1);
    } else if (timePart.startsWith('besok')) {
        const hm = timePart.replace('besok', '').trim();
        const [h, m] = hm.split(':').map(Number);
        fireAt = new Date(now);
        fireAt.setDate(fireAt.getDate() + 1);
        fireAt.setHours(h, m, 0, 0);
    } else {
        const [dateStr, hm] = timePart.split(/\s+/);
        const [h, m] = hm.split(':').map(Number);
        fireAt = new Date(dateStr);
        fireAt.setHours(h, m, 0, 0);
    }

    if (Number.isNaN(fireAt.getTime())) return null;

    const cronExpr = `${fireAt.getMinutes()} ${fireAt.getHours()} ${fireAt.getDate()} ${fireAt.getMonth() + 1} *`;

    return {
        id: Date.now().toString(36),
        message,
        fireAt: fireAt.toISOString(),
        cron: cronExpr,
        createdAt: now.toISOString(),
    };
}

class ReminderScheduler {
    constructor() {
        this.jobs = new Map();
        this.sendFn = null;
    }

    start(sendMessageFn) {
        this.sendFn = sendMessageFn;
        const reminders = loadReminders();
        for (const item of reminders) {
            this.scheduleOne(item);
        }
    }

    scheduleOne(item) {
        if (!cron.validate(item.cron)) return false;
        if (this.jobs.has(item.id)) return true;

        const job = cron.schedule(item.cron, async () => {
            if (this.sendFn) {
                await this.sendFn(`⏰ *Pengingat*\n${item.message}`);
            }
            this.cancel(item.id);
        });

        this.jobs.set(item.id, job);
        return true;
    }

    add(jid, text) {
        const parsed = parseReminderInput(text);
        if (!parsed) {
            return {
                ok: false,
                message: '⚠️ Format: `/ingatkan 20:00 submit tugas` atau `/ingatkan 2026-07-20 20:00 bayar listrik`',
            };
        }

        parsed.jid = jid;
        const list = loadReminders();
        list.push(parsed);
        saveReminders(list);
        this.scheduleOne(parsed);

        const when = new Date(parsed.fireAt).toLocaleString('id-ID');
        return {
            ok: true,
            message: `✅ Pengingat disimpan untuk *${when}*\n📝 ${parsed.message}\n🆔 ID: ${parsed.id}`,
        };
    }

    list() {
        const items = loadReminders();
        if (!items.length) return '📭 Belum ada pengingat aktif.';
        return items.map((r, i) =>
            `${i + 1}. [${r.id}] ${new Date(r.fireAt).toLocaleString('id-ID')} — ${r.message}`
        ).join('\n');
    }

    cancel(id) {
        const job = this.jobs.get(id);
        if (job) {
            job.stop();
            this.jobs.delete(id);
        }
        const list = loadReminders().filter((r) => r.id !== id);
        saveReminders(list);
    }

    cancelById(id) {
        this.cancel(id);
        return `🗑️ Pengingat ${id} dihapus.`;
    }
}

module.exports = { ReminderScheduler, parseReminderInput };

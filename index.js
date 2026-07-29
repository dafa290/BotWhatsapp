const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const sharp = require('sharp');
const express = require('express');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const { MongoClient } = require('mongodb');

const { useMongoDBAuthState } = require('./lib/mongoAuth');
const { ReminderScheduler } = require('./lib/reminders');
const { storeGroupMessage, getGroupMessages, formatForSummary } = require('./lib/group-store');
const { fetchUrlContent, htmlToText, extractUrls, buildSummaryPrompt } = require('./lib/web-summarizer');
const { scanDevices, scanPing, kickDevice, unkickDevice } = require('./lib/network-tools');
const { askGemini, clearGeminiHistory } = require('./geminiApi');

process.on('uncaughtException', (err) => {
    console.error('[Anti-Crash] Uncaught Exception:', err.message || err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('[Anti-Crash] Unhandled Rejection:', reason);
});

const app = express();
const port = 3000;

// Keamanan: isi nomor WA kamu (628xxxxx@c.us). Kosong = semua boleh (tidak disarankan).
const OWNER_JIDS = (process.env.WA_OWNER || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

function isOwner(jid) {
    if (!OWNER_JIDS.length) return true;
    return OWNER_JIDS.some((o) => jid.includes(o.replace(/\D/g, '')) || jid === o);
}

function requireOwner(jid) {
    if (isOwner(jid)) return null;
    return '⛔ Perintah ini khusus owner. Set env WA_OWNER=628xxxxxxxxxx';
}

let qrImage = '';
let connectionStatus = 'Menunggu koneksi...';
let globalSock = null;
const reminderScheduler = new ReminderScheduler();

function splitMessage(text, maxLen = 3500) {
    if (text.length <= maxLen) return [text];
    const parts = [];
    let remaining = text;
    while (remaining.length > 0) {
        if (remaining.length <= maxLen) {
            parts.push(remaining);
            break;
        }
        let cutAt = remaining.lastIndexOf('\n', maxLen);
        if (cutAt < maxLen * 0.3) cutAt = maxLen;
        parts.push(remaining.substring(0, cutAt));
        remaining = remaining.substring(cutAt).trimStart();
    }
    return parts;
}

// ── AUTO-SEND FILES DARI AI RESPONSE ──
async function sendExtractedFiles(sock, jid, text) {
    const regex = /([a-zA-Z0-9_\\\-./]+\.(?:pdf|docx|doc|xlsx|xls|png|jpg|jpeg|webp|txt|csv))/gi;
    let match;
    const sentFiles = new Set();
    while ((match = regex.exec(text)) !== null) {
        let filePath = match[1].trim();
        filePath = filePath.replace(/^[<"']|[>"']$/g, '').trim(); // Bersihkan tag

        // AI kadang mengirim path aneh seperti sandbox:///mnt/... atau markdown links
        // Ambil nama filenya saja (basename) karena file pasti ter-generate di folder bot (cwd)
        const fileName = filePath.split('/').pop().split('\\').pop();
        
        // Hanya cek di folder bot atau path absolut yang aman
        let fullPath = path.resolve(process.cwd(), fileName);
        
        // Fallback: Jika tidak ada di root, coba cari path aslinya barangkali ada folder khusus
        if (!fs.existsSync(fullPath)) {
            fullPath = path.resolve(process.cwd(), filePath.replace('sandbox://', ''));
        }
        
        if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile() && !sentFiles.has(fullPath)) {
            try {
                const ext = path.extname(fullPath).toLowerCase();
                const isImg = ['.png', '.jpg', '.jpeg', '.webp'].includes(ext);
                
                await sock.sendPresenceUpdate('media', jid);
                if (isImg) {
                    await sock.sendMessage(jid, { image: fs.readFileSync(fullPath), caption: path.basename(fullPath) });
                } else {
                    await sock.sendMessage(jid, { document: fs.readFileSync(fullPath), mimetype: 'application/octet-stream', fileName: path.basename(fullPath) });
                }
                sentFiles.add(fullPath);
                console.log(`[Auto-Send] Berhasil mengirim file: ${fullPath}`);
            } catch (err) {
                console.error(`[Auto-Send] Gagal mengirim file ${fullPath}:`, err.message);
            }
        }
    }
}

async function replyText(sock, jid, text, quoted) {
    const parts = splitMessage(text);
    for (const part of parts) {
        await sock.sendMessage(jid, { text: part }, quoted ? { quoted } : undefined);
        if (parts.length > 1) await new Promise((r) => setTimeout(r, 500));
    }
}

let mongoClient;
let authCollection;

async function connectMongo() {
    const uri = process.env.MONGO_URI;
    if (uri) {
        try {
            mongoClient = new MongoClient(uri);
            await mongoClient.connect();
            const db = mongoClient.db('whatsapp_bot');
            authCollection = db.collection('auth_state');
            console.log('✅ Terhubung ke MongoDB untuk penyimpanan 24/7!');
        } catch (error) {
            console.error('❌ Gagal terhubung ke MongoDB:', error);
            authCollection = null;
        }
    } else {
        console.log('⚠️ MONGO_URI tidak ditemukan. Menggunakan penyimpanan lokal.');
    }
}

async function startBot() {
    await connectMongo();
    
    let state, saveCreds;
    if (authCollection) {
        ({ state, saveCreds } = await useMongoDBAuthState(authCollection));
    } else {
        ({ state, saveCreds } = await useMultiFileAuthState('auth_info_baileys'));
    }
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`Menggunakan WA v${version.join('.')}, isLatest: ${isLatest}`);

    const sock = makeWASocket({
        version,
        printQRInTerminal: true,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ['BotWhatsapp', 'Chrome', '1.0.0'],
        retryOnTimeout: true,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
        getMessage: async () => { return {}; },
    });

    globalSock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('QR Code baru diterima. Silakan scan.');
            qrcodeTerminal.generate(qr, { small: true });
            
            qrcode.toDataURL(qr, (err, url) => {
                if (!err) {
                    qrImage = url;
                    connectionStatus = 'Silakan scan QR Code di bawah ini';
                }
            });
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            connectionStatus = 'Koneksi tertutup...';
            qrImage = '';

            if (shouldReconnect) {
                connectionStatus = 'Mencoba menghubungkan kembali...';
                startBot();
            } else {
                connectionStatus = 'Anda telah logout. Restart aplikasi untuk scan ulang.';
            }
        } else if (connection === 'open') {
            console.log('Bot berhasil terhubung ke WhatsApp!');
            connectionStatus = 'Bot terhubung!';
            qrImage = '';

            reminderScheduler.start(async (msg) => {
                for (const owner of OWNER_JIDS.length ? OWNER_JIDS : []) {
                    await sock.sendMessage(owner, { text: msg });
                }
                if (!OWNER_JIDS.length) {
                    console.log('[Reminder]', msg);
                }
            });
        }
    });

    const { fetchKimiChat } = require('./kimi');
    const { fetchDeepSeekChat } = require('./deepseek');
    const { fetchAntigravityHack } = require('./antigravity');
    const { performDeepResearch } = require('./lib/ai-researcher');

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (m.type !== 'notify') return;

        console.log('\n[DEBUG] 📩 Pesan baru dari:', msg.key.remoteJid, '| fromMe:', msg.key.fromMe);
        console.log('[DEBUG] Isi pesan:', JSON.stringify(msg.message));

        storeGroupMessage(msg);

        // Handle ephemeral & view once messages
        let actualMessage = msg.message;
        if (actualMessage?.ephemeralMessage) {
            actualMessage = actualMessage.ephemeralMessage.message;
        } else if (actualMessage?.viewOnceMessage) {
            actualMessage = actualMessage.viewOnceMessage.message;
        } else if (actualMessage?.viewOnceMessageV2) {
            actualMessage = actualMessage.viewOnceMessageV2.message;
        }

        const messageType = Object.keys(actualMessage || {})[0];
        const isImage = messageType === 'imageMessage' ||
            (messageType === 'extendedTextMessage' && actualMessage?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage);

        const messageText = actualMessage?.conversation ||
            actualMessage?.extendedTextMessage?.text ||
            actualMessage?.imageMessage?.caption || '';
        const textLower = messageText.toLowerCase();
        const jid = msg.key.remoteJid;

        if (isImage && textLower.startsWith('/s')) {
            try {
                const targetMessage = messageType === 'imageMessage'
                    ? msg
                    : { message: msg.message.extendedTextMessage.contextInfo.quotedMessage };

                const buffer = await downloadMediaMessage(targetMessage, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                const webpBuffer = await sharp(buffer)
                    .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
                    .webp()
                    .toBuffer();

                await sock.sendMessage(jid, { sticker: webpBuffer }, { quoted: msg });
            } catch (error) {
                await sock.sendMessage(jid, { text: 'Maaf, gagal membuat stiker.' });
            }
            return;
        }

        if (!messageText) return;

        // ── HELP / FITUR ──
        if (textLower === '/help' || textLower === '!help' || textLower === '/f' || textLower === '!f') {
            await replyText(sock, jid, `🤖 *MENU FITUR BOT*

*💻 AI Agent (Kontrol Laptop):*
• \`/d <pesan>\` — AI DeepSeek (Bisa buat folder, coding, jalankan CMD, dll)
• \`/kim <pesan>\` — AI Kimi (Asisten chat)

*⏰ Produktivitas & Otomatisasi:*
• \`/ingatkan 20:00 meeting\` — Pasang alarm/pengingat
• \`/daftarpengingat\` — Lihat semua jadwal alarm
• \`/hapuspengingat <id>\` — Hapus alarm
• \`/ringkas\` — Rangkum chat panjang di grup ini
• \`/link <url>\` — Rangkum isi artikel/website

*📡 Jaringan & Keamanan WiFi:*
• \`!net\` / \`!scanwifi\` — Lacak semua perangkat di WiFi (Butuh Admin)
• \`!scan-alt\` — Scan WiFi ringan (Tanpa Admin)
• \`!test-router\` — Cek koneksi bot ke web admin router
• \`!kick <IP>\` — Tendang perangkat dari WiFi (Otomatis)
• \`!kick-router <IP>\` — Tendang permanen via Router
• \`!kick-arp <IP>\` — Tendang sementara via ARP Spoofing
• \`!unkick <IP>\` — Buka blokir perangkat

*📂 Fitur Lain:*
• \`/kirimfoto C:\\path\\foto.jpg\` — Ambil file dari laptop
• \`/s\` (reply gambar) — Ubah gambar jadi stiker WA`);
            return;
        }

        // ── REMINDERS ──
        if (textLower.startsWith('/ingatkan ')) {
            const denied = requireOwner(jid);
            if (denied) { await replyText(sock, jid, denied); return; }
            const result = reminderScheduler.add(jid, messageText.substring(10).trim());
            await replyText(sock, jid, result.message);
            return;
        }

        if (textLower === '/daftarpengingat') {
            await replyText(sock, jid, reminderScheduler.list());
            return;
        }

        if (textLower.startsWith('/hapuspengingat ')) {
            const denied = requireOwner(jid);
            if (denied) { await replyText(sock, jid, denied); return; }
            const id = messageText.split(/\s+/)[1];
            await replyText(sock, jid, reminderScheduler.cancelById(id));
            return;
        }

        // ── GROUP SUMMARIZER ──
        if (textLower === '/ringkas' || textLower.startsWith('/ringkas ')) {
            const limitMatch = messageText.match(/\d+/);
            const limit = limitMatch ? Math.min(parseInt(limitMatch[0], 10), 200) : 100;
            const messages = getGroupMessages(jid, limit);

            if (!messages.length) {
                await replyText(sock, jid, '📭 Belum ada pesan grup tersimpan. Bot perlu aktif saat chat grup berlangsung.');
                return;
            }

            await sock.sendPresenceUpdate('composing', jid);
            const transcript = formatForSummary(messages);
            const prompt = `Kamu adalah asisten ringkasan grup WhatsApp. Ringkas percakapan berikut dalam Bahasa Indonesia.

Format WAJIB:
📊 *Ringkasan Grup* (${messages.length} pesan)

👥 *Siapa bicara apa:*
• [Nama]: poin penting

✅ *Kesimpulan:*
1. ...
2. ...
3. ...

💬 *Action items* (jika ada):
• ...

--- DATA CHAT ---
${transcript.slice(0, 12000)}`;

            try {
                const summary = await fetchDeepSeekChat(prompt);
                await replyText(sock, jid, summary || 'Gagal merangkum.');
            } catch (e) {
                await replyText(sock, jid, 'Gagal merangkum: ' + e.message);
            }
            return;
        }

        // ── WEB SCRAPER ──
        if (textLower.startsWith('/link ') || textLower.startsWith('!link ')) {
            const urlText = messageText.replace(/^\/link\s|^!link\s/i, '').trim();
            const urls = extractUrls(urlText);
            if (!urls.length) {
                await replyText(sock, jid, '⚠️ Format: `/link https://example.com/artikel`');
                return;
            }

            await sock.sendPresenceUpdate('composing', jid);
            try {
                const url = urls[0];
                const html = await fetchUrlContent(url, 20000);
                const readable = htmlToText(html);
                if (readable.length < 50) {
                    await replyText(sock, jid, '❌ Konten halaman terlalu sedikit atau diblokir.');
                    return;
                }
                const summary = await fetchDeepSeekChat(buildSummaryPrompt(url, readable));
                await replyText(sock, jid, summary || readable.slice(0, 3000));
            } catch (e) {
                await replyText(sock, jid, '❌ Gagal baca link: ' + e.message);
            }
            return;
        }

        // ── NETWORK ──
        if (textLower === '!scanwifi' || textLower === '/scanwifi' || textLower === '!net' || textLower === '/net' || textLower === '!scan') {
            const denied = requireOwner(jid);
            if (denied) { await replyText(sock, jid, denied); return; }
            await replyText(sock, jid, scanDevices());
            return;
        }

        if (textLower === '!scan-alt' || textLower === '/scan-alt' || textLower === '!scan-ping') {
            const denied = requireOwner(jid);
            if (denied) { await replyText(sock, jid, denied); return; }
            await replyText(sock, jid, scanPing());
            return;
        }

        if (textLower.startsWith('!kick ') || textLower.startsWith('/kick ')) {
            const denied = requireOwner(jid);
            if (denied) { await replyText(sock, jid, denied); return; }
            const ip = messageText.split(/\s+/)[1];
            if (!ip) {
                await replyText(sock, jid, '⚠️ Format: !kick 192.168.1.105');
                return;
            }
            await replyText(sock, jid, kickDevice(ip));
            return;
        }

        if (textLower.startsWith('!unkick ') || textLower.startsWith('/unkick ')) {
            const denied = requireOwner(jid);
            if (denied) { await replyText(sock, jid, denied); return; }
            const ip = messageText.split(/\s+/)[1];
            await replyText(sock, jid, unkickDevice(ip));
            return;
        }

        // ── AI ROUTING ──
        if (textLower.startsWith('/kim')) {
            const promptText = messageText.substring(4).trim();
            if (!promptText) return;

            try {
                await sock.sendPresenceUpdate('composing', jid);
                const aiResponse = await fetchKimiChat(promptText);
                if (aiResponse && aiResponse.length > 2) {
                    await replyText(sock, jid, aiResponse);
                    await sendExtractedFiles(sock, jid, aiResponse);
                }
            } catch (error) {
                await sock.sendMessage(jid, { text: 'Maaf, Kimi sedang mengalami gangguan.' });
            }
            return;
        }

        // ── GEMINI API (MANDIRI / CLOUD READY) ──
        if (textLower.startsWith('/a2 ')) {
            const promptText = messageText.substring(4).trim();
            if (!promptText) return;

            try {
                await sock.sendPresenceUpdate('composing', jid);
                const aiResponse = await askGemini(jid, promptText);
                if (aiResponse && aiResponse.length > 2) {
                    await replyText(sock, jid, aiResponse);
                    // Tetap dukung auto-send files jika AI kasih path
                    await sendExtractedFiles(sock, jid, aiResponse);
                }
            } catch (error) {
                await sock.sendMessage(jid, { text: '❌ Maaf, Antigravity 2.0 (Gemini) gagal merespon.' });
            }
            return;
        }

        if (textLower === '/clear-a2') {
            const success = clearGeminiHistory(jid);
            await sock.sendMessage(jid, { text: success ? '🧹 Ingatan Antigravity 2.0 telah dihapus.' : 'ℹ️ Tidak ada ingatan yang perlu dihapus.' });
            return;
        }

        // ── ANTIGRAVITY (HACK) ──
        if (textLower.startsWith('/a ')) {
            const promptText = messageText.substring(3).trim();
            if (!promptText) return;

            try {
                await sock.sendPresenceUpdate('composing', jid);
                // Kita oper sock dan jid agar bisa mengirim respon yang terlambat/lama (background polling)
                const hackResponse = await fetchAntigravityHack(promptText, sock, jid);
                
                // Kalau bukan response background (langsung selesai), kita kirim
                if (hackResponse && hackResponse !== 'BACKGROUND_HANDLED') {
                    await replyText(sock, jid, hackResponse);
                    await sendExtractedFiles(sock, jid, hackResponse);
                }
            } catch (error) {
                await sock.sendMessage(jid, { text: 'Maaf, Antigravity Hack gagal.' });
            }
            return;
        }

        if (textLower.startsWith('/d')) {
            const denied = requireOwner(jid);
            if (denied) { await replyText(sock, jid, denied); return; }

            const promptText = messageText.substring(2).trim();
            if (!promptText) return;

            console.log('Pesan DeepSeek dari', jid, ':', promptText);
            try {
                await sock.sendPresenceUpdate('composing', jid);
                const aiResponse = await fetchDeepSeekChat(promptText);
                if (aiResponse && aiResponse.length > 2) {
                    await replyText(sock, jid, aiResponse);
                    await sendExtractedFiles(sock, jid, aiResponse);
                } else {
                    console.log('DeepSeek respon kosong, tidak dikirim.');
                }
            } catch (error) {
                console.error('Error DeepSeek:', error);
                await sock.sendMessage(jid, {
                    text: 'Maaf, DeepSeek error. Pastikan Start-Chrome-DeepSeek.bat sudah jalan & login.',
                });
            }
            return;
        }

        if (textLower.startsWith('/research ') || textLower.startsWith('/r ')) {
            const denied = requireOwner(jid);
            if (denied) { await replyText(sock, jid, denied); return; }

            const promptText = messageText.substring(textLower.startsWith('/research') ? 9 : 2).trim();
            if (!promptText) return;

            console.log('[DeepResearch] Menerima request:', promptText);
            try {
                await replyText(sock, jid, '🔍 _Sedang mencari informasi di internet secara real-time dan menganalisis (tunggu 10-30 detik)..._');
                await sock.sendPresenceUpdate('composing', jid);
                
                const aiResponse = await performDeepResearch(promptText, fetchDeepSeekChat);
                
                if (aiResponse) {
                    await replyText(sock, jid, aiResponse);
                    await sendExtractedFiles(sock, jid, aiResponse);
                } else {
                    await replyText(sock, jid, '❌ Gagal melakukan deep research.');
                }
            } catch (error) {
                console.error('[DeepResearch] Error:', error);
                await sock.sendMessage(jid, {
                    text: `❌ Error: ${error.message}`
                });
            }
            return;
        }

        if (textLower === '/approve' || textLower === '/gas') {
            const denied = requireOwner(jid);
            if (denied) { await replyText(sock, jid, denied); return; }
            
            await replyText(sock, jid, '✅ Mengirim sinyal otomatis ke laptop (Menekan "Yes, and always allow" + Submit)...');
            const { exec } = require('child_process');
            
            // Script VBScript untuk auto-klik (fokus ke aplikasi yang aktif, tekan 2 lalu Enter)
            const vbsCode = `
Set WshShell = WScript.CreateObject("WScript.Shell")
WScript.Sleep 500
WshShell.SendKeys "2"
WScript.Sleep 200
WshShell.SendKeys "{ENTER}"
            `;
            require('fs').writeFileSync('approve.vbs', vbsCode);
            exec('cscript //nologo approve.vbs', (err) => {
                if(err) console.error(err);
            });
            return;
        }

        if (textLower.startsWith('/kirimfoto') || textLower.startsWith('/sendphoto')) {
            const denied = requireOwner(jid);
            if (denied) { await replyText(sock, jid, denied); return; }

            const filePath = messageText.substring(textLower.startsWith('/kirimfoto') ? 10 : 11).trim();
            if (!filePath) {
                await replyText(sock, jid, '⚠️ Format: /kirimfoto C:\\path\\ke\\foto.jpg');
                return;
            }
            try {
                if (!fs.existsSync(filePath)) {
                    await replyText(sock, jid, '❌ File tidak ditemukan: ' + filePath);
                    return;
                }
                const ext = filePath.split('.').pop().toLowerCase();
                const isImageFile = ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext);

                await sock.sendPresenceUpdate('composing', jid);
                const fileBuffer = fs.readFileSync(filePath);

                if (isImageFile) {
                    await sock.sendMessage(jid, { image: fileBuffer, caption: `📸 ${filePath}` });
                } else {
                    await sock.sendMessage(jid, {
                        document: fileBuffer,
                        mimetype: 'application/octet-stream',
                        fileName: path.basename(filePath),
                    });
                }
            } catch (error) {
                await replyText(sock, jid, '❌ Gagal kirim file: ' + error.message);
            }
        }
    });
}

app.get('/', (req, res) => {
    res.send('Server Bot WhatsApp Berjalan — ketik /help di WA');
});

app.listen(port, () => {
    console.log(`Server Express berjalan di http://localhost:${port}`);
    if (!OWNER_JIDS.length) {
        console.warn('[WARN] WA_OWNER belum diset — semua nomer bisa pakai /d dan !kick. Set: WA_OWNER=628xxxxxxxxxx');
    }
});

startBot();

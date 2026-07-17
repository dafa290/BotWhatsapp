const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const sharp = require('sharp');
const express = require('express');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode');

const app = express();
const port = 3000;

// Variabel global
let qrImage = '';
let connectionStatus = 'Menunggu koneksi...';

// Helper: pecah pesan panjang agar tidak terpotong di WhatsApp
function splitMessage(text, maxLen = 3500) {
    if (text.length <= maxLen) return [text];
    const parts = [];
    let remaining = text;
    while (remaining.length > 0) {
        if (remaining.length <= maxLen) {
            parts.push(remaining);
            break;
        }
        // Cari titik potong terbaik (newline terdekat sebelum batas)
        let cutAt = remaining.lastIndexOf('\n', maxLen);
        if (cutAt < maxLen * 0.3) cutAt = maxLen; // Kalau newline terlalu awal, potong saja
        parts.push(remaining.substring(0, cutAt));
        remaining = remaining.substring(cutAt).trimStart();
    }
    return parts;
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    const sock = makeWASocket({
        printQRInTerminal: true,
        auth: state,
        logger: pino({ level: 'silent' }) 
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('QR Code baru diterima. Silakan scan.');
            qrcode.toDataURL(qr, (err, url) => {
                if (err) {
                    console.error('Error generate QR:', err);
                } else {
                    qrImage = url;
                    connectionStatus = 'Silakan scan QR Code di bawah ini';
                }
            });
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Koneksi tertutup.');
            connectionStatus = 'Koneksi tertutup...';
            qrImage = '';
            
            if (shouldReconnect) {
                console.log('Mencoba menghubungkan kembali...');
                connectionStatus = 'Mencoba menghubungkan kembali...';
                startBot();
            } else {
                console.log('Anda telah logout. Hapus folder "auth_info_baileys" dan restart untuk scan ulang.');
                connectionStatus = 'Anda telah logout. Restart aplikasi untuk scan ulang.';
            }
        } else if (connection === 'open') {
            console.log('Bot berhasil terhubung ke WhatsApp!');
            connectionStatus = 'Bot terhubung!';
            qrImage = '';
        }
    });

    const { fetchKimiChat } = require('./kimi');
    const { fetchDeepSeekChat } = require('./deepseek');

    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        if (m.type === 'notify') {
            const messageType = Object.keys(msg.message || {})[0];
            const isImage = messageType === 'imageMessage' || (messageType === 'extendedTextMessage' && msg.message.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage);

            const messageText = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption;
            const textLower = messageText ? messageText.toLowerCase() : '';

            // Fitur Stiker (hanya jika ada command /s)
            if (isImage && textLower.startsWith('/s')) {
                console.log('Gambar dan command /s terdeteksi, sedang memproses stiker...');
                try {
                    const targetMessage = messageType === 'imageMessage' ? msg : { message: msg.message.extendedTextMessage.contextInfo.quotedMessage };
                    
                    const buffer = await downloadMediaMessage(
                        targetMessage,
                        'buffer',
                        { },
                        { logger: pino({ level: 'silent' }) }
                    );

                    const webpBuffer = await sharp(buffer)
                        .resize(512, 512, {
                            fit: 'contain',
                            background: { r: 0, g: 0, b: 0, alpha: 0 }
                        })
                        .webp()
                        .toBuffer();
                        
                    await sock.sendMessage(msg.key.remoteJid, { sticker: webpBuffer }, { quoted: msg });
                } catch (error) {
                    console.error('Gagal membuat stiker:', error);
                    await sock.sendMessage(msg.key.remoteJid, { text: 'Maaf, gagal membuat stiker dari gambar tersebut.' });
                }
                return;
            }

            if (!messageText) return;

            // Routing commands
            if (textLower.startsWith('/kim')) {
                const promptText = messageText.substring(4).trim();
                if (!promptText) return;

                console.log('Pesan Kimi dari', msg.key.remoteJid, ':', promptText);
                try {
                    await sock.sendPresenceUpdate('composing', msg.key.remoteJid);
                    const aiResponse = await fetchKimiChat(promptText);
                    if (aiResponse && aiResponse.length > 2) {
                        const parts = splitMessage(aiResponse);
                        for (const part of parts) {
                            await sock.sendMessage(msg.key.remoteJid, { text: part });
                            if (parts.length > 1) await new Promise(r => setTimeout(r, 500));
                        }
                    } else {
                        console.log('Kimi mengembalikan respon kosong/invalid, tidak dikirim ke WA.');
                    }
                } catch (error) {
                    console.error('Error Kimi:', error);
                    await sock.sendMessage(msg.key.remoteJid, { text: 'Maaf, Kimi sedang mengalami gangguan.' });
                }
            } 
            else if (textLower.startsWith('/d')) {
                const promptText = messageText.substring(2).trim();
                if (!promptText) return;

                console.log('Pesan DeepSeek dari', msg.key.remoteJid, ':', promptText);
                try {
                    await sock.sendPresenceUpdate('composing', msg.key.remoteJid);
                    const aiResponse = await fetchDeepSeekChat(promptText);
                    if (aiResponse && aiResponse.length > 2) {
                        const parts = splitMessage(aiResponse);
                        for (const part of parts) {
                            await sock.sendMessage(msg.key.remoteJid, { text: part });
                            if (parts.length > 1) await new Promise(r => setTimeout(r, 500));
                        }
                    } else {
                        console.log('DeepSeek mengembalikan respon kosong/invalid, tidak dikirim ke WA.');
                    }
                } catch (error) {
                    console.error('Error DeepSeek:', error);
                    await sock.sendMessage(msg.key.remoteJid, { text: 'Maaf, DeepSeek sedang mengalami gangguan (pastikan Start-Chrome-DeepSeek.bat berjalan).' });
                }
            }
            else if (textLower.startsWith('/kirimfoto') || textLower.startsWith('/sendphoto')) {
                const filePath = messageText.substring(textLower.startsWith('/kirimfoto') ? 10 : 11).trim();
                if (!filePath) {
                    await sock.sendMessage(msg.key.remoteJid, { text: '⚠️ Format: /kirimfoto C:\\path\\ke\\foto.jpg' });
                    return;
                }
                try {
                    if (!fs.existsSync(filePath)) {
                        await sock.sendMessage(msg.key.remoteJid, { text: '❌ File tidak ditemukan: ' + filePath });
                        return;
                    }
                    const ext = filePath.split('.').pop().toLowerCase();
                    const isImageFile = ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext);
                    
                    await sock.sendPresenceUpdate('composing', msg.key.remoteJid);
                    const fileBuffer = fs.readFileSync(filePath);
                    
                    if (isImageFile) {
                        await sock.sendMessage(msg.key.remoteJid, { image: fileBuffer, caption: `📸 Foto dari laptop\n📁 ${filePath}` });
                    } else {
                        await sock.sendMessage(msg.key.remoteJid, { document: fileBuffer, mimetype: 'application/octet-stream', fileName: filePath.split('\\').pop() });
                    }
                    console.log('✅ File terkirim:', filePath);
                } catch (error) {
                    console.error('Error kirim file:', error);
                    await sock.sendMessage(msg.key.remoteJid, { text: '❌ Gagal mengirim file: ' + error.message });
                }
                return;
            }
        }
    });
}

// Endpoint status
app.get('/', (req, res) => {
    res.send('Server Bot WhatsApp Berjalan');
});

app.listen(port, () => {
    console.log(`Server Express berjalan di http://localhost:${port}`);
});

startBot();

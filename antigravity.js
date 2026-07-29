// Matikan verifikasi SSL karena server lokal IDE menggunakan self-signed certificate
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const fs = require('fs');
const readline = require('readline');

// Data dari Inspect Element Anda
const LOCAL_IDE_PORT = '60560';
const CSRF_TOKEN = '5d85af0e-0a98-46d1-9773-1f97c5d122b9';
const CASCADE_ID = 'f0b3e504-5d9f-4db5-9789-9b977497ac11';

// Path transcript
const TRANSCRIPT_PATH = "C:\\Users\\Savira\\.gemini\\antigravity-ide\\brain\\f0b3e504-5d9f-4db5-9789-9b977497ac11\\.system_generated\\logs\\transcript.jsonl";

// Konfigurasi payload
const CASCADE_CONFIG = {
    "plannerConfig": {
        "conversational": {
            "plannerMode": "CONVERSATIONAL_PLANNER_MODE_DEFAULT",
            "agenticMode": true
        },
        "toolConfig": {
            "runCommand": { "autoCommandConfig": { "autoExecutionPolicy": "CASCADE_COMMANDS_AUTO_EXECUTION_EAGER" } },
            "notifyUser": { "artifactReviewMode": "ARTIFACT_REVIEW_MODE_NEVER" },
            "permissionConfig": { "defaultGrants": { "ask": ["read_url(*)"] } }
        },
        "requestedModel": { "model": "MODEL_PLACEHOLDER_M16" },
        "ephemeralMessagesConfig": { "enabled": true },
        "knowledgeConfig": { "enabled": true }
    },
    "conversationHistoryConfig": { "enabled": true }
};

// Helper functions buat nge-split dan kirim ke WA (nyontek dari index.js)
function splitMessage(text, maxLen = 3500) {
    if (text.length <= maxLen) return [text];
    const parts = [];
    let remaining = text;
    while (remaining.length > 0) {
        if (remaining.length <= maxLen) { parts.push(remaining); break; }
        let cutAt = remaining.lastIndexOf('\n', maxLen);
        if (cutAt < maxLen * 0.3) cutAt = maxLen;
        parts.push(remaining.substring(0, cutAt));
        remaining = remaining.substring(cutAt).trimStart();
    }
    return parts;
}

async function sendToWA(sock, jid, text) {
    const parts = splitMessage(text);
    for (const part of parts) {
        await sock.sendMessage(jid, { text: part });
        if (parts.length > 1) await new Promise(r => setTimeout(r, 500));
    }
    
    // Auto send file (sama kayak di index.js)
    const path = require('path');
    const regex = /([a-zA-Z0-9_\\\-./]+\.(?:pdf|docx|doc|xlsx|xls|png|jpg|jpeg|webp|txt|csv))/gi;
    let match;
    const sentFiles = new Set();
    while ((match = regex.exec(text)) !== null) {
        let filePath = match[1].trim().replace(/^[<"']|[>"']$/g, '').trim();
        const fileName = filePath.split('/').pop().split('\\').pop();
        let fullPath = path.resolve(process.cwd(), fileName);
        if (!fs.existsSync(fullPath)) fullPath = path.resolve(process.cwd(), filePath.replace('sandbox://', ''));
        if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile() && !sentFiles.has(fullPath)) {
            try {
                const ext = path.extname(fullPath).toLowerCase();
                const isImg = ['.png', '.jpg', '.jpeg', '.webp'].includes(ext);
                if (isImg) {
                    await sock.sendMessage(jid, { image: fs.readFileSync(fullPath), caption: path.basename(fullPath) });
                } else {
                    await sock.sendMessage(jid, { document: fs.readFileSync(fullPath), mimetype: 'application/octet-stream', fileName: path.basename(fullPath) });
                }
                sentFiles.add(fullPath);
            } catch (err) {}
        }
    }
}

// Fungsi baca baris terakhir di JSONL
async function getLastModelResponse(startStepIndex, sock = null, jid = null) {
    return new Promise((resolve) => {
        let attempts = 0;
        const maxSyncAttempts = 5; // 5 detik sinkron (lebih cepat agar terasa realtime)
        
        const checkInterval = setInterval(async () => {
            attempts++;
            try {
                if (fs.existsSync(TRANSCRIPT_PATH)) {
                    const fileData = fs.readFileSync(TRANSCRIPT_PATH, 'utf-8');
                    const lines = fileData.trim().split('\n');
                    
                    for (let i = lines.length - 1; i >= 0; i--) {
                        if (!lines[i]) continue;
                        try {
                            const row = JSON.parse(lines[i]);
                            if (row.step_index > startStepIndex && row.source === 'MODEL' && row.type === 'PLANNER_RESPONSE' && row.status === 'DONE') {
                                if (row.content && row.content.trim().length > 0) {
                                    clearInterval(checkInterval);
                                    
                                    // Kalau ini hasil background polling (lama), kita push ke WA
                                    if (attempts > maxSyncAttempts && sock && jid) {
                                        await sendToWA(sock, jid, `✅ *Tugas Panjang Selesai!*\n\n${row.content}`);
                                    }
                                    resolve(row.content);
                                    return;
                                }
                            }
                        } catch (e) {}
                    }
                }
            } catch (error) {}

            // Kalau lebih dari 15 detik, resolve untuk ngabarin user, TAPI loop tetep jalan di background!
            if (attempts === maxSyncAttempts) {
                resolve("BACKGROUND_HANDLED"); // Balikkan ke index.js biar tau ini dilanjut di background
                if (sock && jid) {
                    await sock.sendMessage(jid, { text: '⏱️ _AI membutuhkan waktu lebih lama..._\n_Jika proses macet/terlalu lama, kemungkinan AI butuh persetujuan keamanan di laptop. Ketik perintah_ */approve* _untuk mengizinkannya secara otomatis dari HP Anda!_' });
                }
            }
            
            // Berhenti setelah 5 menit (300 detik) biar gak nyangkut selamanya
            if (attempts >= 300) {
                clearInterval(checkInterval);
                if (sock && jid && attempts > maxSyncAttempts) {
                    await sock.sendMessage(jid, { text: '❌ _(Timeout 5 Menit: Proses AI dihentikan secara paksa atau gagal)_' });
                }
            }
        }, 1000);
    });
}

// Fungsi bantu cari step_index terakhir saat ini
function getCurrentMaxStepIndex() {
    try {
        if (!fs.existsSync(TRANSCRIPT_PATH)) return 0;
        const fileData = fs.readFileSync(TRANSCRIPT_PATH, 'utf-8');
        const lines = fileData.trim().split('\n');
        let maxIndex = 0;
        for (let i = lines.length - 1; i >= 0; i--) {
            if (!lines[i]) continue;
            try {
                const row = JSON.parse(lines[i]);
                if (row.step_index > maxIndex) maxIndex = row.step_index;
            } catch(e){}
        }
        return maxIndex;
    } catch(e) {
        return 0;
    }
}

async function fetchAntigravityHack(message, sock = null, jid = null) {
    const url = `https://127.0.0.1:${LOCAL_IDE_PORT}/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage`; 
    
    const headers = {
        'accept': '*/*',
        'accept-language': 'en-US',
        'content-type': 'application/json',
        'origin': 'vscode-file://vscode-app',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'cross-site',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) AntigravityIDE/1.107.0 Chrome/142.0.7444.175 Electron/39.2.3 Safari/537.36',
        'x-codeium-csrf-token': CSRF_TOKEN
    };

    const payload = {
        cascadeId: CASCADE_ID,
        items: [{ text: message }],
        cascadeConfig: CASCADE_CONFIG
    };

    try {
        console.log(`[Antigravity Hack] Menyadap memori IDE untuk menjawab: ${message}`);
        
        // Catat index log sebelum mengirim pesan
        const startIndex = getCurrentMaxStepIndex();

        // 1. Tembakkan pesan ke IDE
        const response = await fetch(url, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            return `❌ Gagal mengirim ke IDE: ${response.status} ${response.statusText}`;
        }

        // 2. Baca isi memori otak Antigravity secara live (dengan support background polling)
        const aiAnswer = await getLastModelResponse(startIndex, sock, jid);
        
        return aiAnswer;

    } catch (error) {
        return `❌ Error menghubungi IDE lokal: ${error.message}`;
    }
}

module.exports = { fetchAntigravityHack };

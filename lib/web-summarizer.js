const http = require('http');
const https = require('https');

function fetchUrlContent(url, maxBytes = 12000) {
    return new Promise((resolve, reject) => {
        const transport = url.startsWith('https://') ? https : http;
        const req = transport.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            },
            rejectUnauthorized: false,
        }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return resolve(fetchUrlContent(res.headers.location, maxBytes));
            }
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                body += chunk;
                if (body.length > maxBytes * 2) body = body.slice(0, maxBytes * 2);
            });
            res.on('end', () => resolve(body.slice(0, maxBytes)));
        });
        req.setTimeout(15000, () => req.destroy(new Error('Timeout')));
        req.on('error', reject);
    });
}

function htmlToText(html) {
    return String(html || '')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ')
        .trim();
}

function extractUrls(text) {
    const matches = text.match(/https?:\/\/[^\s<>"']+/gi) || [];
    return [...new Set(matches.map((u) => u.replace(/[.,;:!?)]+$/, '')))];
}

function buildSummaryPrompt(url, content) {
    return `Ringkas artikel/halaman web berikut dalam BAHASA INDONESIA.
Format WAJIB:
📌 *Judul/Topik*
1. Poin utama pertama
2. Poin utama kedua
3. Poin utama ketiga
🔗 Sumber: ${url}

Konten halaman:
${content.slice(0, 6000)}`;
}

module.exports = {
    fetchUrlContent,
    htmlToText,
    extractUrls,
    buildSummaryPrompt,
};

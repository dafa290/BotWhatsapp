require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Inisialisasi Gemini API
// Pastikan GEMINI_API_KEY ada di file .env
const apiKey = process.env.GEMINI_API_KEY || "MASUKKAN_API_KEY_ANDA_DISINI";
const genAI = new GoogleGenerativeAI(apiKey);

const systemInstruction = `
You are an elite, highly advanced AI coding assistant and researcher, modeled after the "Antigravity IDE" powered by Gemini Pro. 
Your primary function is to assist a highly technical user with software engineering, complex system architecture, deep web research, roadmapping, and providing extremely accurate, production-ready code.

Guidelines:
1. CAPABILITIES: Act as if you have full knowledge of modern tech stacks. You can design complete applications, debug complex issues, and write extensive documentation.
2. TONE: Professional, highly intelligent, slightly hacker-esque ("Agen"), confident, and concise. No fluff. 
3. FORMATTING: Use markdown extensively. For code, use standard fenced code blocks with language specifiers. Highlight important concepts.
4. PROBLEM SOLVING: When asked to build something, provide the complete roadmap, the folder structure, and the exact code for the necessary files. Do not give partial snippets unless asked.
5. LIMITATIONS: Since you are running in a WhatsApp bot environment, tell the user exactly what commands to run on their terminal to deploy your code, or output code that the bot's auto-save functionality can parse.

You must be 99% as capable as a native IDE-integrated AI. Deliver maximum value in every response.
`;

// Menyimpan history chat berdasarkan nomor WA (JID)
const chatHistories = {};

async function askGemini(jid, prompt) {
    try {
        if (apiKey === "MASUKKAN_API_KEY_ANDA_DISINI" || !apiKey) {
            return "❌ API Key Gemini belum diatur. Silakan buka file `.env` atau `geminiApi.js` dan masukkan API Key Anda.";
        }

        const model = genAI.getGenerativeModel({
            model: "gemini-2.5-pro", // Menggunakan model pro terbaru
            systemInstruction: systemInstruction,
        });

        // Inisialisasi history jika belum ada
        if (!chatHistories[jid]) {
            chatHistories[jid] = [];
        }

        const chat = model.startChat({
            history: chatHistories[jid],
            generationConfig: {
                maxOutputTokens: 8192,
                temperature: 0.7,
            },
        });

        const result = await chat.sendMessage(prompt);
        const responseText = result.response.text();

        // Simpan ke history (Gemini SDK otomatis mengelola format 'user' dan 'model' di internal chat object, 
        // tapi kita bisa simpan manual jika ingin persistensi. Untuk versi ini, chat object akan handle selama memory aktif)
        // Note: startChat memelihara state internal, jadi kita simpan object chat-nya saja.

        return responseText;
    } catch (error) {
        console.error("Gemini API Error:", error);
        return `❌ Terjadi kesalahan pada otak AI Gemini: ${error.message}`;
    }
}

// Versi yang lebih baik untuk menyimpan object chat per JID
const chatSessions = {};

async function askGeminiStateful(jid, prompt) {
     try {
        if (apiKey === "MASUKKAN_API_KEY_ANDA_DISINI" || !apiKey) {
            return "❌ *SYSTEM ALERT*: Akses Ditolak.\n\nAPI Key Gemini belum ditanamkan ke dalam inti server. Silakan edit file `.env` dan masukkan `GEMINI_API_KEY=kunci_anda_disini` untuk mengaktifkan mode Dewa (Antigravity 2.0).";
        }

        const model = genAI.getGenerativeModel({
            model: "gemini-flash-latest", 
            systemInstruction: systemInstruction,
        });

        if (!chatSessions[jid]) {
            chatSessions[jid] = model.startChat({
                history: [],
                generationConfig: {
                    maxOutputTokens: 8192,
                    temperature: 0.7,
                },
            });
        }

        const chat = chatSessions[jid];
        const result = await chat.sendMessage(prompt);
        return result.response.text();

    } catch (error) {
        console.error("Gemini API Error:", error);
        return `❌ *SYSTEM FAILURE*: Gagal mengakses Neural Network Gemini.\n\nError Log: ${error.message}`;
    }
}

function clearGeminiHistory(jid) {
    if (chatSessions[jid]) {
        delete chatSessions[jid];
        return true;
    }
    return false;
}

module.exports = {
    askGemini: askGeminiStateful,
    clearGeminiHistory
};

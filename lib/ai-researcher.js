const google = require('googlethis');
const https = require('https');

async function performDeepResearch(query, fetchDeepSeekFunc) {
    try {
        console.log(`[DeepResearch] Mencari: ${query}`);
        
        let searchContext = "";
        
        // 1. Search Web menggunakan googlethis
        const options = {
            page: 0,
            safe: false,
            parse_ads: false,
            additional_params: {
                hl: 'id' // Bahasa Indonesia
            },
            axios_config: {
                timeout: 10000, // 10 detik batas waktu
                httpsAgent: new https.Agent({ rejectUnauthorized: false })
            }
        };
        
        try {
            const searchResults = await google.search(query, options);
            
            if (searchResults.results && searchResults.results.length > 0) {
                // 2. Ambil top 5 hasil pencarian
                const topResults = searchResults.results.slice(0, 5);
                searchContext = "HASIL PENCARIAN INTERNET (REAL-TIME):\n\n";
                
                topResults.forEach((res, index) => {
                    searchContext += `${index + 1}. Judul: ${res.title}\n`;
                    searchContext += `   Snippet: ${res.description}\n`;
                    searchContext += `   Link: ${res.url}\n\n`;
                });
            } else {
                console.log("[DeepResearch] Tidak ada hasil dari Google, menggunakan pengetahuan bawaan AI.");
            }
        } catch (searchError) {
            console.log("[DeepResearch] Pencarian gagal/terblokir, menggunakan pengetahuan bawaan AI. Error:", searchError.message);
        }

        // 3. Bangun Prompt Khusus untuk Deep Researcher
        const prompt = `Kamu adalah Konsultan Riset Senior (Deep Researcher AI).
Tugasmu adalah menjawab pertanyaan atau menganalisis ide dari pengguna berdasarkan data real-time dari internet yang disediakan di bawah ini.

PERMINTAAN USER:
"${query}"

${searchContext ? searchContext : "Data internet saat ini tidak dapat diakses. Gunakan basis data/pengetahuan yang kamu miliki."}

INSTRUKSI KHUSUS UNTUKMU:
1. Berikan jawaban yang komprehensif, strategis, dan berbasis data dari hasil pencarian di atas.
2. Jangan hanya meringkas! Sintesis informasi tersebut menjadi Insight (Wawasan).
3. Sertakan referensi/pengalaman dari masa lalu (historical data/case studies) jika ada di hasil pencarian, untuk dijadikan pelajaran.
4. Berikan saran atau kesimpulan yang solid (actionable advice).
5. Gunakan bahasa Indonesia yang asik, cerdas, tapi mudah dipahami. Gunakan styling bold/italic secukupnya agar rapi.
6. Sertakan daftar referensi link di akhir (Sumber Bacaan).`;

        // 4. Minta AI menganalisis
        const aiResponse = await fetchDeepSeekFunc(prompt);
        return aiResponse;

    } catch (error) {
        console.error('[DeepResearch] Error:', error);
        return `❌ Gagal melakukan riset: ${error.message}`;
    }
}

module.exports = {
    performDeepResearch
};

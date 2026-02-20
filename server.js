
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const CryptoJS = require('crypto-js');
const WebSocket = require('ws');
const path = require('path');
const https = require('https');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Azure OpenAI Config ───────────────────────────────────────────────────
const AZURE_CONFIG = {
    endpoint: 'https://innochat-eus2.openai.azure.com/',
    apiKey: '6036acce36954f1aa7923996e0278538',
    apiVersion: '2025-01-01-preview',
    deployment: 'gpt-5-chat-2'
};

async function callAzureOpenAI(messages, maxTokens = 600) {
    const url = `${AZURE_CONFIG.endpoint}openai/deployments/${AZURE_CONFIG.deployment}/chat/completions?api-version=${AZURE_CONFIG.apiVersion}`;
    const body = JSON.stringify({ messages, max_tokens: maxTokens, temperature: 0.85 });
    return new Promise((resolve, reject) => {
        const req = https.request(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'api-key': AZURE_CONFIG.apiKey }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data).choices[0].message.content); }
                catch (e) { reject(new Error('Parse error: ' + data)); }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// ─── Official PSC Sections ────────────────────────────────────────────────
// Keyed by the same IDs used in the frontend
const PSC_SECTIONS = {
    dan_yin_jie:    { zh: '单音节字词', desc: 'A single Chinese character (one syllable). Focus on initials and finals.' },
    duo_yin_jie:    { zh: '多音节词语', desc: 'A two-to-three syllable Mandarin word or compound. Focus on tone sandhi.' },
    lang_du:        { zh: '朗读短文',   desc: 'A natural Mandarin paragraph of 3-5 sentences suitable for PSC reading aloud (朗读短文). Clear, formal, standard written Chinese.' },
    ming_ti:        { zh: '命题说话',   desc: 'A free-talk prompt question for 3-minute speech (命题说话). E.g. 请谈谈你最难忘的一次旅行' },
    xuan_ze:        { zh: '选择判断',   desc: 'A short sentence containing a common Cantonese-influenced Mandarin error (选择判断). The sentence should sound plausible but contain a word usage mistake.' }
};

const GRADE_DESC = {
    1: 'Grade 1 (一级) — broadcaster/native level: use advanced formal vocabulary, complex sentence structures',
    2: 'Grade 2 (二级) — professional level: clear everyday Mandarin, moderate complexity',
    3: 'Grade 3 (三级) — baseline level: simple everyday conversational sentences'
};

// ─── Sentence Pool ────────────────────────────────────────────────────────
// Map: `${section}_${grade}` -> array of {text, chars}
const sentencePool = {};
const POOL_TARGET = 50; // Target pool size per section+grade
const POOL_MIN    = 5;  // Start serving once we have this many

async function generateOneSentence(section, grade) {
    const secInfo = PSC_SECTIONS[section];
    if (!secInfo) return null;
    const messages = [
        {
            role: 'system',
            content: `You are a PSC (普通话水平测试) exam coach. Respond with ONLY valid JSON in this format:
{"text":"完整文本","chars":[{"c":"字","p":"pīnyīn"},{"c":"，","p":""},...]}
Rules: "text" = full Simplified Chinese. "chars" = every character/punctuation with tone-marked pinyin. Punctuation gets p="". No markdown, no extra text.`
        },
        {
            role: 'user',
            content: `Generate one practice item for PSC section: ${secInfo.zh}. Task: ${secInfo.desc}. Level: ${GRADE_DESC[grade] || GRADE_DESC[3]}.`
        }
    ];
    const isLongSection = section === 'lang_du';
    const tokenLimit = isLongSection ? 900 : 450;

    try {
        const raw = await callAzureOpenAI(messages, tokenLimit);
        // Strip markdown code fences if model wraps in ```json
        let cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
        // Attempt to repair truncated JSON (add closing brackets if missing)
        if (!cleaned.endsWith('}')) {
            // Find the last complete char entry and close
            const lastComma = cleaned.lastIndexOf('{"c"');
            if (lastComma > -1) {
                // Remove incomplete last item and close the array+object
                cleaned = cleaned.substring(0, cleaned.lastIndexOf(',', lastComma)).trimEnd() + ']}';
            } else {
                cleaned += ']}'; // best-effort
            }
        }
        const parsed = JSON.parse(cleaned);
        if (parsed.text && Array.isArray(parsed.chars)) return parsed;
    } catch (e) {
        console.warn(`Pool gen failed (${section}_${grade}):`, e.message);
    }
    return null;
}

function poolKey(section, grade) { return `${section}_${grade}`; }

async function fillPool(section, grade, count = 10) {
    const key = poolKey(section, grade);
    if (!sentencePool[key]) sentencePool[key] = [];
    const promises = Array.from({ length: count }, () =>
        generateOneSentence(section, grade).then(s => { if (s) sentencePool[key].push(s); })
    );
    await Promise.allSettled(promises);
    console.log(`Pool [${key}]: ${sentencePool[key].length} sentences ready`);
}

// Pre-warm pool at startup for all sections & grades
(async () => {
    const sections = Object.keys(PSC_SECTIONS);
    const grades = [1, 2, 3];
    // Fill 5 each quickly to reach POOL_MIN
    for (const g of grades) {
        for (const s of sections) {
            fillPool(s, g, 5).catch(() => {}); // fire & forget
        }
    }
})();

function maintainPool(section, grade) {
    const key = poolKey(section, grade);
    const current = (sentencePool[key] || []).length;
    if (current < POOL_TARGET) {
        const needed = Math.min(10, POOL_TARGET - current);
        fillPool(section, grade, needed).catch(() => {});
    }
}

// ─── REST: Get Next Sentence ──────────────────────────────────────────────
app.post('/api/generate-content', async (req, res) => {
    const { section, grade, previousText } = req.body;
    const key = poolKey(section, grade);

    if (!sentencePool[key]) sentencePool[key] = [];
    const pool = sentencePool[key];

    // Filter out the previous sentence
    const available = previousText
        ? pool.filter(s => s.text !== previousText)
        : pool;

    if (available.length > 0) {
        // Serve from pool
        const idx = Math.floor(Math.random() * available.length);
        const sentence = available[idx];
        // Remove from pool
        const globalIdx = pool.indexOf(sentence);
        if (globalIdx !== -1) pool.splice(globalIdx, 1);
        // Trigger background refill
        maintainPool(section, grade);
        return res.json(sentence);
    }

    // Pool empty — generate on-demand
    console.log(`Pool empty for ${key}, generating on-demand...`);
    const sentence = await generateOneSentence(section, grade);
    if (sentence) {
        maintainPool(section, grade);
        return res.json(sentence);
    }

    res.status(500).json({ error: 'Could not generate sentence' });
});

// ─── REST: Generate Tabular Report ───────────────────────────────────────
app.post('/api/generate-report', async (req, res) => {
    const { history, lang } = req.body;
    const langName = lang === 'en' ? 'English'
                   : lang === 'hk' ? 'Traditional Chinese (Cantonese users)'
                   : 'Simplified Chinese';

    const historyStr = history.map((h, i) =>
        `Row ${i+1}: Section="${h.section}" | Text="${h.text}" | Score=${(h.totalScore||0).toFixed(1)} | Tone=${(h.tone||0).toFixed(1)} | Fluency=${(h.fluency||0).toFixed(1)} | Errors=[${h.errors.join(', ') || 'none'}]`
    ).join('\n');

    const messages = [
        {
            role: 'system',
            content: `You are a PSC (普通话水平测试) coach writing a report card in ${langName}. 
Return ONLY an HTML string (no markdown, no code fences) containing:
1. A <table> with columns: # | 练习内容 | 得分 | 声调 | 流利度 | 错误字 | 改进建议
2. A short <div class="report-summary"> paragraph with top-3 tips.
Use inline styles for the table: border-collapse:collapse, td padding 8px 12px, alternating row background rgba(255,255,255,0.05).
Color scores: green if >=80, orange if >=60, red if <60.`
        },
        {
            role: 'user',
            content: `Generate the report card HTML for this session:\n${historyStr}`
        }
    ];

    try {
        const report = await callAzureOpenAI(messages, 1200);
        const cleaned = report.trim().replace(/^```html\s*/i, '').replace(/```\s*$/, '').trim();
        res.json({ report: cleaned });
    } catch (e) {
        console.error('Report error:', e);
        res.status(500).json({ error: 'Failed to generate report' });
    }
});

// ─── ISE Audio Proxy (unchanged) ─────────────────────────────────────────
const config = {
    hostUrl: "ws://ise-api-sg.xf-yun.com/v2/ise",
    host: "ise-api-sg.xf-yun.com",
    appid: "ga8f3190",
    apiSecret: "cfe3bd189aa401d2f18c6bf9ce3acce4",
    apiKey: "d0e596d68d3bd4c89ec10293ceb68509",
    uri: "/v2/ise",
};

function getAuthStr(date) {
    let signatureOrigin = `host: ${config.host}\ndate: ${date}\nGET ${config.uri} HTTP/1.1`;
    let signatureSha = CryptoJS.HmacSHA256(signatureOrigin, config.apiSecret);
    let signature = CryptoJS.enc.Base64.stringify(signatureSha);
    let authorizationOrigin = `api_key="${config.apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
    return CryptoJS.enc.Base64.stringify(CryptoJS.enc.Utf8.parse(authorizationOrigin));
}

const FRAME = { STATUS_FIRST_FRAME: 0, STATUS_CONTINUE_FRAME: 1, STATUS_LAST_FRAME: 2 };

io.on('connection', (socket) => {
    console.log('New client connected');
    let ws = null;

    socket.on('start-evaluation', (data) => {
        const { language, text } = data;
        let date = new Date().toUTCString();
        let wssUrl = config.hostUrl + "?authorization=" + getAuthStr(date) + "&date=" + date + "&host=" + config.host;
        ws = new WebSocket(wssUrl);

        ws.on('open', () => {
            let frame = {
                "common": { app_id: config.appid },
                "business": {
                    "sub": "ise", "ent": language, "category": "read_sentence",
                    "text": '\uFEFF' + text, "tte": "utf-8", "rstcd": "utf8",
                    "ttp_skip": true, "cmd": "ssb", "aue": "raw", "auf": "audio/L16;rate=16000"
                },
                "data": { "status": 0 }
            };
            ws.send(JSON.stringify(frame));
            socket.emit('ise-status', 'Connected');
        });

        ws.on('message', (message) => {
            try {
                let res = JSON.parse(message);
                if (res.code != 0) { socket.emit('ise-error', `Error ${res.code}: ${res.message}`); return; }
                if (res.data && res.data.data) {
                    let b = Buffer.from(res.data.data, 'base64');
                    socket.emit('ise-result', { status: res.data.status, xml: b.toString(), raw: res.data });
                }
            } catch (e) { console.error('Error parsing ISE response', e); }
        });

        ws.on('close', () => socket.emit('ise-status', 'Connection Closed'));
        ws.on('error', (err) => socket.emit('ise-error', 'WebSocket Error'));
    });

    socket.on('audio-data', (pcmData) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({
            "common": { "app_id": config.appid },
            "business": { "aus": 2, "cmd": "auw", "aue": "raw" },
            "data": { "status": 1, "data": Buffer.from(pcmData).toString('base64') }
        }));
    });

    socket.on('stop-evaluation', () => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({
            "common": { "app_id": config.appid },
            "business": { "aus": 4, "cmd": "auw", "aue": "raw" },
            "data": { "status": 2, "data": "" }
        }));
    });

    socket.on('disconnect', () => { if (ws) ws.close(); console.log('Client disconnected'); });
});

const PORT = 3000;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));


const socket = io();

// ─── State ────────────────────────────────────────────────────────────────
const STATE = {
    lang: 'en',
    grade: 1,
    activeSection: null,
    currentText: '',      // clean Mandarin string (no HTML)
    currentChars: [],     // [{c, p}, ...] from last API call
    sessionHistory: [],
    recordingBuffer: [],  // Float32 samples accumulated during recording
    playbackUrl: null     // Object URL of last recording WAV
};

// ─── DOM ──────────────────────────────────────────────────────────────────
const screens = {
    onboarding: document.getElementById('onboarding'),
    dashboard:  document.getElementById('dashboard'),
    exercise:   document.getElementById('exercise'),
    report:     document.getElementById('report')
};

const langBtns      = document.querySelectorAll('.lang-btn');
const gradeBtns     = document.querySelectorAll('.grade-btn');
const startJourneyBtn = document.getElementById('start-journey-btn');
const recordBtn     = document.getElementById('record-btn');
const resultArea    = document.getElementById('result-area');
const yodaModal     = document.getElementById('yoda-modal');
const feedbackOverlay = document.getElementById('feedback-overlay');
const targetTextEl  = document.getElementById('target-text');

// ─── Localization ─────────────────────────────────────────────────────────
// Section titles per language (matching NEW section IDs from server)
const SECTION_TITLES = {
    dan_yin_jie: { en: '单音节字词 — Single Syllable', hk: '單音節字詞 — 單字', cn: '单音节字词' },
    duo_yin_jie: { en: '多音节词语 — Multi-syllable',  hk: '多音節詞語 — 複詞', cn: '多音节词语' },
    lang_du:     { en: '朗读短文 — Read Aloud',         hk: '朗讀短文 — 朗讀', cn: '朗读短文' },
    ming_ti:     { en: '命题说话 — Free Talk',          hk: '命題說話 — 自由講', cn: '命题说话' },
    xuan_ze:     { en: '选择判断 — Word Choice',        hk: '選擇判斷 — 選擇', cn: '选择判断' }
};

const LOCALE = {
    en: {
        welcome: 'Welcome to Yoda',
        subtitle: 'Your AI personal trainer for the Putonghua Proficiency Test (PSC).',
        tips: {
            success: 'Yoda! Native Level Proficiency!',
            good: 'Good effort. Watch the highlighted tones.',
            bad: 'Keep going! Focus on slow, clear pronunciation.'
        }
    },
    cn: {
        welcome: '欢迎来到 Yoda (優答)',
        subtitle: '您的普通话水平测试 AI 专属教练。',
        tips: {
            success: '優答！您已达到母语水平！',
            good: '不错。注意高亮单词的声调。',
            bad: '继续加油。请放慢语速，清晰发音。'
        }
    },
    hk: {
        welcome: '歡迎來到 Yoda (優答)',
        subtitle: '您的普通話水平測試 AI 專屬教練。',
        tips: {
            success: '優答！您已達到母語水平！',
            good: '唔錯。注意高亮字嘅聲調。',
            bad: '繼續努力。試下放慢語速，清晰啲。'
        }
    }
};

// ─── Event Listeners ─────────────────────────────────────────────────────

langBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        langBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        STATE.lang = btn.dataset.lang;
        updateUIText();
        // Re-render current prompt with/without pinyin
        if (STATE.currentChars.length > 0) {
            renderPromptWithPinyin(STATE.currentChars, STATE.currentText);
        }
    });
});

gradeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        gradeBtns.forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        STATE.grade = parseInt(btn.dataset.grade);
        startJourneyBtn.disabled = false;
    });
});

startJourneyBtn.addEventListener('click', () => switchScreen('dashboard'));

recordBtn.addEventListener('click', async () => {
    if (!isRecording) startRecording();
    else stopRecording();
});

// ─── Navigation ───────────────────────────────────────────────────────────

function switchScreen(name) {
    Object.values(screens).forEach(el => el.classList.remove('active'));
    screens[name].classList.add('active');
}

window.goToDashboard = () => {
    stopRecording();
    switchScreen('dashboard');
};

window.closeModal = () => yodaModal.classList.remove('show');

function updateUIText() {
    document.getElementById('welcome-title').innerText  = LOCALE[STATE.lang].welcome;
    document.getElementById('welcome-subtitle').innerText = LOCALE[STATE.lang].subtitle;
    if (STATE.activeSection) {
        const titles = SECTION_TITLES[STATE.activeSection] || {};
        document.getElementById('exercise-title').innerText = titles[STATE.lang] || STATE.activeSection;
    }
}

// ─── Exercise Start ───────────────────────────────────────────────────────

window.startExercise = async (section) => {
    STATE.activeSection = section;
    switchScreen('exercise');

    // Reset UI
    resultArea.classList.add('hidden');
    feedbackOverlay.style.display = 'none';
    feedbackOverlay.innerHTML = '';
    targetTextEl.style.display = 'flex';
    recordBtn.classList.remove('recording');
    document.getElementById('record-text').innerText = 'Start Recording';
    isRecording = false;

    const titles = SECTION_TITLES[section] || {};
    document.getElementById('exercise-title').innerText = titles[STATE.lang] || section;

    await generateNextContent(section);
};

// ─── GenAI Content Fetch ──────────────────────────────────────────────────

async function generateNextContent(section, previousText) {
    // Show loading state
    targetTextEl.innerHTML = '<span class="generating-label">⏳ Generating…</span>';
    targetTextEl.style.display = 'flex';
    feedbackOverlay.style.display = 'none';
    feedbackOverlay.innerHTML = '';

    try {
        const res = await fetch('/api/generate-content', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                section: section || STATE.activeSection,
                grade: STATE.grade,
                previousText: previousText || ''
            })
        });
        const data = await res.json();
        if (data.text) {
            STATE.currentText  = data.text;
            STATE.currentChars = data.chars || [];
            renderPromptWithPinyin(STATE.currentChars, STATE.currentText);
        }
    } catch (e) {
        console.error('Content gen failed:', e);
        STATE.currentText = '今天天气很好。';
        STATE.currentChars = [];
        targetTextEl.innerText = STATE.currentText;
    }
}

// ─── Render Prompt With Pinyin ────────────────────────────────────────────
// Groups consecutive non-punctuation chars into "word blocks" so pinyin
// appears as a phrase under the word, not split per character.

function renderPromptWithPinyin(chars, plainText) {
    const showPinyin = STATE.lang !== 'cn';

    if (!chars || chars.length === 0 || !showPinyin) {
        targetTextEl.innerText = plainText;
        return;
    }

    // Group chars into word-blocks: split on punctuation (p === "")
    const groups = [];
    let current = [];
    chars.forEach(item => {
        if (!item.p) {
            if (current.length) { groups.push({ type: 'word', items: current }); current = []; }
            groups.push({ type: 'punct', char: item.c });
        } else {
            current.push(item);
        }
    });
    if (current.length) groups.push({ type: 'word', items: current });

    targetTextEl.innerHTML = groups.map(g => {
        if (g.type === 'punct') {
            return `<div class="char-block punct-block"><span class="char-text">${g.char}</span></div>`;
        }
        // Whole word: join chars, join pinyins with space
        const hanzi  = g.items.map(i => i.c).join('');
        const pinyin = g.items.map(i => i.p).join(' ');
        return `<div class="char-block word-block" onclick="playPronunciation('${hanzi}')" title="Click to hear">
                    <span class="char-text">${hanzi}</span>
                    <span class="pinyin-text">${pinyin}</span>
                </div>`;
    }).join('');
}

// ─── Next Sentence ────────────────────────────────────────────────────────

window.nextSentence = async () => {
    resultArea.classList.add('hidden');
    feedbackOverlay.style.display = 'none';
    feedbackOverlay.innerHTML = '';
    targetTextEl.style.display = 'flex';
    document.getElementById('record-text').innerText = 'Start Recording';
    recordBtn.classList.remove('recording');
    isRecording = false;
    await generateNextContent(STATE.activeSection, STATE.currentText);
};

// ─── Complete Session → Report ────────────────────────────────────────────

window.completeSession = async () => {
    if (STATE.sessionHistory.length === 0) {
        alert('Complete at least one attempt first!');
        return;
    }
    switchScreen('report');
    document.getElementById('report-content').innerHTML = '<p>⏳ Generating your report card…</p>';
    try {
        const res = await fetch('/api/generate-report', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ history: STATE.sessionHistory, lang: STATE.lang })
        });
        const data = await res.json();
        if (data.report) {
            document.getElementById('report-content').innerHTML = data.report;
        }
    } catch (e) {
        document.getElementById('report-content').innerHTML = '<p>Failed to generate report. Please try again.</p>';
    }
};

// ─── Full Sentence TTS ────────────────────────────────────────────────────

window.listenFullSentence = () => {
    playPronunciation(STATE.currentText, 0.75);
};

// ── Yoda Reaction Popup ───────────────────────────────────
function showYodaPopup(imgFile, message, score) {
    // Remove any existing popup
    const old = document.getElementById('yoda-popup');
    if (old) old.remove();

    const popup = document.createElement('div');
    popup.id = 'yoda-popup';
    popup.className = 'yoda-popup';

    const lines = message.split('\n');
    popup.innerHTML = `
        <img class="popup-img" src="assets/${imgFile}" alt="Yoda Reaction"
             onerror="this.src='assets/Yoda.png'">
        <div class="popup-msg">
            <span class="popup-score">${score}</span>
            <span>${lines[0]}</span><br>
            <span style="opacity:0.7;font-size:0.8rem">${lines[1] || ''}</span>
        </div>
    `;

    document.body.appendChild(popup);
    // Trigger animation on next frame
    requestAnimationFrame(() => popup.classList.add('show'));

    // Remove from DOM after animation completes (3.2s total)
    setTimeout(() => popup.remove(), 3300);
}

// Play back the user's own recorded voice
window.playMyRecording = () => {
    if (!STATE.playbackUrl) {
        alert('No recording yet — record yourself first!');
        return;
    }
    const audio = new Audio(STATE.playbackUrl);
    audio.play();
};

window.playPronunciation = (text, rate = 0.85) => {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const utt = new SpeechSynthesisUtterance(text);
    utt.lang = 'zh-CN';
    utt.rate = rate;
    window.speechSynthesis.speak(utt);
};

// ─── WAV Encoder ──────────────────────────────────────────────────────────
function encodeWAV(samples, sampleRate) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view   = new DataView(buffer);
    const writeStr = (off, str) => { for (let i=0; i<str.length; i++) view.setUint8(off+i, str.charCodeAt(i)); };
    writeStr(0,  'RIFF');
    view.setUint32(4,  36 + samples.length * 2, true);
    writeStr(8,  'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);        // chunk size
    view.setUint16(20, 1,  true);        // PCM
    view.setUint16(22, 1,  true);        // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); // byte rate
    view.setUint16(32, 2,  true);        // block align
    view.setUint16(34, 16, true);        // bits per sample
    writeStr(36, 'data');
    view.setUint32(40, samples.length * 2, true);
    let offset = 44;
    for (let i = 0; i < samples.length; i++, offset += 2) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    return new Blob([buffer], { type: 'audio/wav' });
}

// ─── Audio Recording ──────────────────────────────────────────────────────

let isRecording = false;
let audioContext, processor, input, stream;

async function startRecording() {
    try {
        document.getElementById('record-text').innerText = 'Processing…';
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const sampleRate = audioContext.sampleRate;
        input     = audioContext.createMediaStreamSource(stream);
        processor = audioContext.createScriptProcessor(4096, 1, 1);
        input.connect(processor);
        processor.connect(audioContext.destination);

        // Reset local capture buffer
        STATE.recordingBuffer = [];
        if (STATE.playbackUrl) { URL.revokeObjectURL(STATE.playbackUrl); STATE.playbackUrl = null; }

        socket.emit('start-evaluation', {
            language: 'cn_vip',
            text: STATE.currentText || '今天天气很好。'
        });

        processor.onaudioprocess = (e) => {
            if (!isRecording) return;
            const inputData = e.inputBuffer.getChannelData(0);
            // Capture a copy for local playback at original quality
            STATE.recordingBuffer.push(new Float32Array(inputData));
            const down = downsampleBuffer(inputData, sampleRate, 16000);
            socket.emit('audio-data', floatTo16BitPCM(down));
        };

        isRecording = true;
        recordBtn.classList.add('recording');
        document.getElementById('record-text').innerText = 'Stop';

        // Keep prompt visible during recording
        feedbackOverlay.style.display = 'none';
        targetTextEl.style.display = 'flex';

    } catch (err) {
        console.error(err);
        alert('Microphone Error: ' + err.message);
    }
}

function stopRecording() {
    if (!isRecording) return;
    isRecording = false;
    recordBtn.classList.remove('recording');
    document.getElementById('record-text').innerText = 'Start Recording';

    // Build WAV blob from captured buffer for local playback
    if (STATE.recordingBuffer.length > 0 && audioContext) {
        const sr = audioContext.sampleRate;
        const totalLen = STATE.recordingBuffer.reduce((s, b) => s + b.length, 0);
        const merged = new Float32Array(totalLen);
        let offset = 0;
        for (const chunk of STATE.recordingBuffer) { merged.set(chunk, offset); offset += chunk.length; }
        const wavBlob = encodeWAV(merged, sr);
        STATE.playbackUrl = URL.createObjectURL(wavBlob);
    }

    if (processor) { processor.disconnect(); input.disconnect(); }
    if (stream)    { stream.getTracks().forEach(t => t.stop()); }
    if (audioContext) audioContext.close();
    socket.emit('stop-evaluation');
}

// ─── ISE Result Handling ──────────────────────────────────────────────────

socket.on('ise-result', (data) => renderResult(data.xml));
socket.on('ise-error',  (msg)  => console.error('ISE error:', msg));

function renderResult(xmlStr) {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlStr, 'text/xml');

    let metricsNode = xmlDoc.getElementsByTagName('read_chapter')[0];
    let isMandarin  = false;

    if (!metricsNode) {
        const recPaper = xmlDoc.getElementsByTagName('rec_paper')[0];
        if (recPaper) {
            metricsNode = recPaper.getElementsByTagName('read_sentence')[0];
            isMandarin  = true;
        }
    }
    if (!metricsNode) { console.error('No metrics in XML'); return; }

    const totalScore = parseFloat(metricsNode.getAttribute('total_score') || 0);
    const integrity  = parseFloat(metricsNode.getAttribute('integrity_score') || 0);
    const fluency    = parseFloat(metricsNode.getAttribute('fluency_score')   || 0);
    const phone      = parseFloat(metricsNode.getAttribute('phone_score')     || 0);
    const tone       = parseFloat(metricsNode.getAttribute('tone_score')      || 0);

    const pct = isMandarin ? totalScore : (totalScore / 5) * 100;

    // ── Show Yoda reaction popup ──
    const reactionMessages = {
        'Try_Again_Yoda.png': '再试一次！\nKeep going!',
        'right_yoda.png':     '还不错！\nNot bad!',
        'good_yoda.png':      '做得好！\nGreat job!',
        'Yoda.png':           '優答！\nNative Level! 🏆'
    };
    let reactionImg;
    if      (pct < 30)              reactionImg = 'Try_Again_Yoda.png';
    else if (pct >= 50 && pct < 70) reactionImg = 'right_yoda.png';
    else if (pct >= 70 && pct < 95) reactionImg = 'good_yoda.png';
    else if (pct >= 95)             reactionImg = 'Yoda.png';
    else                            reactionImg = 'Try_Again_Yoda.png';
    showYodaPopup(reactionImg, reactionMessages[reactionImg], Math.round(pct));

    // Update chart
    document.querySelector('.circle').style.strokeDasharray = `${pct}, 100`;
    document.querySelector('.percentage').textContent = Math.round(pct);

    document.getElementById('score-tone').innerText      = isMandarin ? Math.round(tone)      : 'N/A';
    document.getElementById('score-fluency').innerText   = Math.round(fluency);
    document.getElementById('score-phone').innerText     = Math.round(phone);
    document.getElementById('score-integrity').innerText = Math.round(integrity);

    resultArea.classList.remove('hidden');

    // ── Feedback overlay: horizontal, word-grouped ──
    let errorChars = [];
    if (isMandarin) {
        const wordNodes = metricsNode.getElementsByTagName('word');
        let html = '';
        for (let i = 0; i < wordNodes.length; i++) {
            const content = wordNodes[i].getAttribute('content');
            const syll = wordNodes[i].getElementsByTagName('syll')[0];
            let isError = false;
            if (syll) {
                const phones = syll.getElementsByTagName('phone');
                for (let p = 0; p < phones.length; p++) {
                    const err = phones[p].getAttribute('perr_msg');
                    if (err && err !== '0') { isError = true; break; }
                }
            }
            if (isError) errorChars.push(content);
            const cls = isError ? 'score-low' : 'score-high';
            html += `<span class="char-score ${cls}" onclick="playPronunciation('${content}')" title="${isError ? 'Mispronounced — click to hear' : 'Correct'}">${content}</span>`;
        }
        if (html) {
            // Hide prompt, show feedback HORIZONTALLY
            targetTextEl.style.display = 'none';
            feedbackOverlay.innerHTML  = html;
            feedbackOverlay.style.display = 'flex';
        }
    }

    // Save to history (always, no limit)
    STATE.sessionHistory.push({
        section:    STATE.activeSection,
        text:       STATE.currentText,
        totalScore, tone, fluency, phone, integrity,
        errors:     [...new Set(errorChars)]
    });

    // Tip / Yoda modal
    if (pct >= 90) {
        document.getElementById('tip-text').innerText = LOCALE[STATE.lang].tips.success;
        setTimeout(() => yodaModal.classList.add('show'), 500);
    } else {
        document.getElementById('tip-text').innerText =
            pct > 60 ? LOCALE[STATE.lang].tips.good : LOCALE[STATE.lang].tips.bad;
    }
}

// ─── Audio Helpers ────────────────────────────────────────────────────────

function downsampleBuffer(buffer, sampleRate, outSampleRate) {
    if (outSampleRate === sampleRate) return buffer;
    const ratio     = sampleRate / outSampleRate;
    const newLength = Math.round(buffer.length / ratio);
    const result    = new Float32Array(newLength);
    let resIdx = 0, bufIdx = 0;
    while (resIdx < result.length) {
        const next = Math.round((resIdx + 1) * ratio);
        let accum = 0, count = 0;
        for (let i = bufIdx; i < next && i < buffer.length; i++) { accum += buffer[i]; count++; }
        result[resIdx] = accum / count;
        resIdx++;
        bufIdx = next;
    }
    return result;
}

function floatTo16BitPCM(input) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]));
        out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return out.buffer;
}

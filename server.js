/**
 * 💵 Petty Cash Voucher — Batch Serial Number Scanner
 * Powered by Groq AI Vision
 *
 * FLOW:
 *   1. node server.js
 *   2. Open http://localhost:3000/pc on your PC browser (keep open)
 *   3. Open http://<PC-IP>:3000 on your phone
 *   4. Take 1 photo of multiple bills
 *   5. Groq reads ALL serials at once
 *   6. If any are unreadable → phone prompts retake for that bill
 *   7. Final formatted string auto-copies to PC clipboard
 *   8. Ctrl+V into your Word textbox  ✅
 *
 * FORMAT: $20 : PH55457641C || $10 : PB39461676B
 */

const http  = require('http');
const https = require('https');
const os    = require('os');
const fs    = require('fs');
const path  = require('path');

// ── CONFIG ───────────────────────────────────────────────────
const GROQ_API_KEY = process.env.GROQ_API_KEY || 'YOUR_GROQ_API_KEY';
const GROQ_MODEL   = 'meta-llama/llama-4-scout-17b-16e-instruct';
const PORT         = process.env.PORT || 3001;
const SERIAL_FILE  = path.join(os.homedir(), 'serial_scan.txt'); // VBA reads from here
// ─────────────────────────────────────────────────────────────

const sseClients = new Set();
let   lastPush   = null;
let   lastSignature = null;  // base64 PNG from phone signature pad

// ── GROQ: BATCH SCAN MULTIPLE BILLS ──────────────────────────
function callGroqBatch(base64Image, mimeType) {
  return new Promise((resolve, reject) => {
    const prompt =
      'You are an expert at reading US dollar bill serial numbers. ' +
      'This image may contain ONE or MULTIPLE dollar bills arranged in any way. ' +
      'For EACH bill you can see, extract: ' +
      '(1) the serial number (8-11 alphanumeric characters, printed twice on each bill), ' +
      '(2) the denomination (1, 2, 5, 10, 20, 50, or 100). ' +
      'If a serial number is partially obscured or unreadable for any bill, ' +
      'set serial_number to "UNREADABLE" for that bill. ' +
      'Respond ONLY with a valid JSON array — no markdown, no explanation, nothing else. ' +
      'Example: [{"serial_number":"AB12345678C","denomination":"20"},{"serial_number":"UNREADABLE","denomination":"10"}]';

    const body = JSON.stringify({
      model: GROQ_MODEL,
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } },
          { type: 'text', text: prompt }
        ]
      }]
    });

    const options = {
      hostname: 'api.groq.com',
      path:     '/openai/v1/chat/completions',
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Authorization':  `Bearer ${GROQ_API_KEY}`,
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message));
          const text  = parsed.choices[0].message.content.trim().replace(/```json|```/g, '').trim();
          const bills = JSON.parse(text);
          if (!Array.isArray(bills)) throw new Error('Expected array');
          resolve(bills);
        } catch (e) {
          reject(new Error('Groq parse error: ' + data.slice(0, 300)));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── GROQ: SINGLE BILL RETAKE ──────────────────────────────────
function callGroqSingle(base64Image, mimeType) {
  return new Promise((resolve, reject) => {
    const prompt =
      'You are an expert at reading US dollar bill serial numbers. ' +
      'Look at this image of a single dollar bill. ' +
      'Extract the serial number (8-11 alphanumeric characters) and denomination. ' +
      'Respond ONLY with valid JSON: {"serial_number":"AB12345678C","denomination":"20"} ' +
      'If still unreadable, use "UNREADABLE".';

    const body = JSON.stringify({
      model: GROQ_MODEL,
      max_tokens: 150,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } },
          { type: 'text', text: prompt }
        ]
      }]
    });

    const options = {
      hostname: 'api.groq.com',
      path:     '/openai/v1/chat/completions',
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Authorization':  `Bearer ${GROQ_API_KEY}`,
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message));
          const text = parsed.choices[0].message.content.trim().replace(/```json|```/g, '').trim();
          resolve(JSON.parse(text));
        } catch (e) {
          reject(new Error('Groq parse error: ' + data.slice(0, 300)));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── MULTIPART PARSER ─────────────────────────────────────────
function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      const ct  = req.headers['content-type'] || '';
      const bm  = ct.match(/boundary=(.+)$/);
      if (!bm) return reject(new Error('No boundary'));
      const boundary  = '--' + bm[1];
      const start     = buf.indexOf(boundary) + boundary.length;
      const headerEnd = buf.indexOf('\r\n\r\n', start) + 4;
      const headerStr = buf.slice(start, headerEnd).toString();
      const ctMatch   = headerStr.match(/Content-Type:\s*([^\r\n]+)/i);
      const mimeType  = ctMatch ? ctMatch[1].trim() : 'image/jpeg';
      const nextB     = buf.indexOf(Buffer.from('\r\n' + boundary), headerEnd);
      const imageData = buf.slice(headerEnd, nextB > -1 ? nextB : buf.length);
      resolve({ imageData, mimeType });
    });
    req.on('error', reject);
  });
}

// ── PUSH CLIPBOARD STRING TO PC ──────────────────────────────
function pushToPC(clipboardStr, bills) {
  const payload = JSON.stringify({ clipboard: clipboardStr, bills });
  const msg = `data: ${payload}\n\n`;
  for (const client of sseClients) {
    try { client.write(msg); } catch (_) { sseClients.delete(client); }
  }
  lastPush = { clipboard: clipboardStr, bills };

  // Write to file — VBA reads this directly, no tab focus needed
  try {
    fs.writeFileSync(SERIAL_FILE, clipboardStr, 'utf8');
    console.log(`  💾 Written to file: ${SERIAL_FILE}`);
  } catch (e) {
    console.error('  ⚠️  Could not write serial file:', e.message);
  }

  console.log(`  📡 Pushed to ${sseClients.size} PC client(s): ${clipboardStr}`);
}

// ── FORMAT BILLS → CLIPBOARD STRING ──────────────────────────
function formatClipboard(bills) {
  return bills
    .map(b => `$${b.denomination} : ${b.serial_number}`)
    .join(' || ');
}

// ── PHONE HTML ────────────────────────────────────────────────
const PHONE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>💵 Batch Bill Scanner</title>
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;700;800&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<style>
  :root{--g:#00C853;--g2:#00E676;--dark:#0A0F0A;--card:#111811;--bd:#1E2E1E;--tx:#E8F5E9;--mu:#557755;--gold:#FFD600;--red:#FF5252;--orange:#FF9100;}
  *{margin:0;padding:0;box-sizing:border-box;}
  body{background:var(--dark);color:var(--tx);font-family:'Syne',sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;}
  body::before{content:'';position:fixed;inset:0;background-image:linear-gradient(rgba(0,200,83,.04) 1px,transparent 1px),linear-gradient(90deg,rgba(0,200,83,.04) 1px,transparent 1px);background-size:40px 40px;pointer-events:none;z-index:0;}
  .wrap{position:relative;z-index:1;width:100%;max-width:480px;padding:20px 18px 48px;display:flex;flex-direction:column;gap:16px;}
  header{text-align:center;padding-top:12px;}
  .logo{font-size:12px;font-family:'JetBrains Mono',monospace;color:var(--g);letter-spacing:.2em;text-transform:uppercase;margin-bottom:6px;}
  h1{font-size:32px;font-weight:800;line-height:1;background:linear-gradient(135deg,#fff 40%,var(--g2));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;}
  .sub{font-size:12px;color:var(--mu);margin-top:4px;font-family:'JetBrains Mono',monospace;}

  /* Capture zone */
  .capture-zone{background:var(--card);border:2px dashed var(--bd);border-radius:14px;overflow:hidden;position:relative;cursor:pointer;transition:border-color .3s;}
  .capture-zone:hover,.capture-zone.active{border-color:var(--g);}
  .capture-zone input{position:absolute;inset:0;opacity:0;cursor:pointer;font-size:100px;z-index:2;}
  .cam-preview{width:100%;aspect-ratio:4/3;object-fit:cover;display:none;}
  .cam-preview.show{display:block;}
  .cam-ph{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:32px 20px;}
  .cam-ph.hide{display:none;}
  .cam-icon{font-size:48px;}
  .cam-label{font-size:14px;font-weight:700;}
  .cam-hint{font-size:11px;color:var(--mu);font-family:'JetBrains Mono',monospace;text-align:center;}

  /* Processing overlay */
  .processing{background:var(--card);border:1px solid var(--g);border-radius:14px;padding:20px;display:none;flex-direction:column;align-items:center;gap:10px;animation:up .3s ease;}
  .processing.show{display:flex;}
  .proc-spinner{width:32px;height:32px;border:3px solid var(--bd);border-top-color:var(--g);border-radius:50%;animation:spin .7s linear infinite;}
  .proc-text{font-family:'JetBrains Mono',monospace;font-size:13px;color:var(--g2);}
  @keyframes spin{to{transform:rotate(360deg)}}

  /* Buttons */
  .btn{width:100%;padding:16px;font-family:'Syne',sans-serif;font-size:16px;font-weight:800;border:none;border-radius:12px;cursor:pointer;letter-spacing:.04em;text-transform:uppercase;transition:background .2s,transform .1s;display:flex;align-items:center;justify-content:center;gap:8px;}
  .btn:active{transform:scale(.98);}
  .btn-more{background:#0A2010;border:1px solid var(--g);color:var(--g2);}
  .btn-more:hover{background:#0F2F15;}
  .btn-done{background:var(--g);color:#000;}
  .btn-done:hover{background:var(--g2);}
  .btn-retake{background:#1A1200;border:1px solid var(--orange);color:var(--orange);}
  .btn-retake:hover{background:#2A1E00;}
  .spinner{width:18px;height:18px;border:3px solid rgba(0,0,0,.3);border-top-color:#000;border-radius:50%;animation:spin .7s linear infinite;display:none;}
  .spinning .spinner{display:block;}
  .spinning .btn-label{display:none;}

  /* Phase cards */
  .phase-card{background:var(--card);border:1px solid var(--bd);border-radius:14px;padding:16px 18px;display:none;flex-direction:column;gap:12px;animation:up .3s ease;}
  .phase-card.show{display:flex;}
  @keyframes up{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
  .phase-title{font-size:11px;font-family:'JetBrains Mono',monospace;letter-spacing:.15em;text-transform:uppercase;color:var(--mu);}
  .phase-count{font-size:11px;font-family:'JetBrains Mono',monospace;color:var(--gold);}

  /* Bill list */
  .bill-list{display:flex;flex-direction:column;gap:6px;}
  .bill-row{display:flex;align-items:center;gap:10px;padding:10px 12px;background:#0A150A;border:1px solid var(--bd);border-radius:10px;}
  .bill-row.ok{border-color:var(--g);}
  .bill-row.bad{border-color:var(--red);background:#1A0000;}
  .bill-badge{font-size:18px;flex-shrink:0;}
  .bill-info{flex:1;display:flex;flex-direction:column;gap:2px;}
  .bill-serial{font-family:'JetBrains Mono',monospace;font-size:13px;font-weight:600;color:var(--tx);}
  .bill-denom{font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--gold);}
  .bill-status{font-size:11px;font-family:'JetBrains Mono',monospace;flex-shrink:0;}
  .bill-status.ok{color:var(--g);}
  .bill-status.bad{color:var(--red);}

  /* More bills zone */
  .more-zone{background:var(--card);border:2px dashed var(--g);border-radius:14px;overflow:hidden;position:relative;cursor:pointer;transition:border-color .3s;display:none;}
  .more-zone.show{display:block;}
  .more-zone input{position:absolute;inset:0;opacity:0;cursor:pointer;font-size:100px;z-index:2;}
  .more-ph{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:24px 20px;}
  .more-preview{width:100%;aspect-ratio:4/3;object-fit:cover;display:none;}
  .more-preview.show{display:block;}

  /* Retake prompt */
  .retake-card{background:#0F0800;border:2px solid var(--orange);border-radius:14px;padding:16px 18px;display:none;flex-direction:column;gap:12px;animation:up .3s ease;}
  .retake-card.show{display:flex;}
  .retake-title{font-size:13px;font-weight:700;color:var(--orange);}
  .retake-hint{font-size:12px;font-family:'JetBrains Mono',monospace;color:var(--mu);}
  .retake-input{position:relative;}
  .retake-input input{position:absolute;inset:0;opacity:0;cursor:pointer;font-size:100px;z-index:2;}
  .retake-preview{width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:8px;display:none;}
  .retake-preview.show{display:block;}
  .retake-ph{background:#1A1000;border:1px dashed var(--orange);border-radius:8px;padding:20px;text-align:center;font-size:12px;font-family:'JetBrains Mono',monospace;color:var(--orange);}
  .retake-ph.hide{display:none;}

  /* Success */
  .success-card{background:#051205;border:2px solid var(--g);border-radius:14px;padding:16px 18px;display:none;flex-direction:column;gap:10px;animation:up .3s ease;}
  .success-card.show{display:flex;}
  .success-title{font-size:12px;font-family:'JetBrains Mono',monospace;letter-spacing:.15em;text-transform:uppercase;color:var(--g);}
  .clipboard-str{font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--g2);word-break:break-all;line-height:1.6;background:#0A1F0A;padding:10px 12px;border-radius:8px;}
  .copied-badge{font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--g);display:flex;align-items:center;gap:6px;}

  .error-msg{background:#1A0000;border:1px solid #5A1010;border-radius:10px;padding:12px;font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--red);display:none;}
  .error-msg.show{display:block;animation:up .3s ease;}
  .divider{height:1px;background:var(--bd);border:none;}
  footer{text-align:center;font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--mu);padding-top:4px;}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="logo">⚡ Groq AI Vision</div>
    <h1>Batch Scanner</h1>
    <p class="sub">// photo bills · auto-processes</p>
  </header>

  <!-- Main capture zone -->
  <div class="capture-zone" id="captureZone">
    <input type="file" id="fileInput" accept="image/*" capture="environment">
    <img class="cam-preview" id="preview">
    <div class="cam-ph" id="camPh">
      <div class="cam-icon">📷</div>
      <div class="cam-label">Tap to photograph bills</div>
      <div class="cam-hint">Photo processes automatically<br>all serial numbers extracted at once</div>
    </div>
  </div>

  <!-- Processing indicator -->
  <div class="processing" id="processing">
    <div class="proc-spinner"></div>
    <div class="proc-text" id="procText">⚡ Reading serials...</div>
  </div>

  <div class="error-msg" id="errorMsg"></div>

  <!-- Results -->
  <div class="phase-card" id="resultsCard">
    <div style="display:flex;justify-content:space-between;align-items:center;">
      <div class="phase-title">📋 Bills Detected</div>
      <div class="phase-count" id="billCount"></div>
    </div>
    <div class="bill-list" id="billList"></div>

    <!-- Scan more prompt — shown after all bills are OK -->
    <div id="scanMoreSection" style="display:none;flex-direction:column;gap:10px;">
      <div style="font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--mu);text-align:center;">Have more bills to add?</div>
      <div style="display:flex;gap:10px;">
        <button class="btn btn-more" id="btnMore" style="flex:1;padding:12px;">📷 Scan More</button>
        <button class="btn btn-done" id="btnDone" style="flex:1;padding:12px;">✅ Done</button>
      </div>
    </div>
  </div>

  <!-- More bills capture zone (hidden until Scan More is tapped) -->
  <div class="more-zone" id="moreZone">
    <input type="file" id="moreInput" accept="image/*" capture="environment">
    <img class="more-preview" id="morePreview">
    <div class="more-ph" id="morePh">
      <div class="cam-icon">📷</div>
      <div class="cam-label" style="font-size:13px;">Tap to photograph more bills</div>
    </div>
  </div>

  <!-- Retake prompt -->
  <div class="retake-card" id="retakeCard">
    <div class="retake-title">⚠️ Unreadable bill — retake needed</div>
    <div class="retake-hint" id="retakeHint"></div>
    <div class="retake-input">
      <input type="file" id="retakeFile" accept="image/*" capture="environment">
      <div class="retake-ph" id="retakePh">📷 Tap to photograph this bill alone</div>
      <img class="retake-preview" id="retakePreview">
    </div>
    <button class="btn btn-retake" id="retakeBtn" disabled>
      <div class="spinner"></div>
      <span class="btn-label">🔄 Re-Scan This Bill</span>
    </button>
  </div>

  <!-- Success -->
  <div class="success-card" id="successCard">
    <div class="success-title">✅ Sent to PC</div>
    <div class="clipboard-str" id="clipboardStr"></div>
    <div class="copied-badge">💾 Written to serial_scan.txt · open Word to continue</div>
    <button class="btn btn-more" id="btnReset" style="margin-top:4px;">🔄 Start New Scan</button>
  </div>

  <hr class="divider">
  <footer>Photo auto-processes · no button needed</footer>
</div>

<script>
  let bills      = [];
  let retakeIndex = -1;

  const fileInput    = document.getElementById('fileInput');
  const preview      = document.getElementById('preview');
  const camPh        = document.getElementById('camPh');
  const processing   = document.getElementById('processing');
  const procText     = document.getElementById('procText');
  const errorMsg     = document.getElementById('errorMsg');
  const resultsCard  = document.getElementById('resultsCard');
  const billList     = document.getElementById('billList');
  const billCount    = document.getElementById('billCount');
  const scanMoreSection = document.getElementById('scanMoreSection');
  const moreZone     = document.getElementById('moreZone');
  const moreInput    = document.getElementById('moreInput');
  const morePreview  = document.getElementById('morePreview');
  const morePh       = document.getElementById('morePh');
  const retakeCard   = document.getElementById('retakeCard');
  const retakeHint   = document.getElementById('retakeHint');
  const retakeFile   = document.getElementById('retakeFile');
  const retakePh     = document.getElementById('retakePh');
  const retakePreview= document.getElementById('retakePreview');
  const retakeBtn    = document.getElementById('retakeBtn');
  const successCard  = document.getElementById('successCard');
  const clipboardStr = document.getElementById('clipboardStr');

  // ── Main photo selected → auto process ───────────────────
  fileInput.addEventListener('change', async e => {
    const file = e.target.files[0]; if (!file) return;
    preview.src = URL.createObjectURL(file);
    preview.classList.add('show');
    camPh.classList.add('hide');
    hide([errorMsg, resultsCard, retakeCard, successCard, moreZone]);
    bills = [];
    await processBatch(file, false);
  });

  // ── More bills photo selected → auto process & append ────
  moreInput.addEventListener('change', async e => {
    const file = e.target.files[0]; if (!file) return;
    morePreview.src = URL.createObjectURL(file);
    morePreview.classList.add('show');
    morePh.classList.add('hide');
    await processBatch(file, true);
  });

  // ── Process batch photo ───────────────────────────────────
  async function processBatch(file, append) {
    processing.classList.add('show');
    procText.textContent = append ? '⚡ Adding more bills...' : '⚡ Reading serials...';
    scanMoreSection.style.display = 'none';
    hide([errorMsg, retakeCard]);

    try {
      const fd = new FormData(); fd.append('bill', file);
      const res  = await fetch('/scan-batch', {method:'POST', body:fd});
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Server error');

      if (append) {
        bills = bills.concat(data);  // add to existing
      } else {
        bills = data;
      }

      renderBills();
      checkForUnreadable();
    } catch(e) {
      showError(e.message);
    } finally {
      processing.classList.remove('show');
    }
  }

  // ── Scan More button ──────────────────────────────────────
  document.getElementById('btnMore').addEventListener('click', () => {
    scanMoreSection.style.display = 'none';
    morePreview.classList.remove('show');
    morePh.classList.remove('hide');
    moreInput.value = '';
    moreZone.classList.add('show');
    moreZone.scrollIntoView({behavior:'smooth', block:'center'});
  });

  // ── Done button → finalize and send to PC ─────────────────
  document.getElementById('btnDone').addEventListener('click', () => {
    finalize();
  });

  // ── Reset button ──────────────────────────────────────────
  document.getElementById('btnReset').addEventListener('click', () => {
    bills = [];
    retakeIndex = -1;
    fileInput.value = '';
    preview.classList.remove('show');
    camPh.classList.remove('hide');
    hide([errorMsg, resultsCard, retakeCard, successCard, moreZone, processing]);
    window.scrollTo({top:0, behavior:'smooth'});
  });

  // ── Retake file selected → auto process ──────────────────
  retakeFile.addEventListener('change', async e => {
    const file = e.target.files[0]; if (!file) return;
    retakePreview.src = URL.createObjectURL(file);
    retakePreview.classList.add('show');
    retakePh.classList.add('hide');
    retakeBtn.disabled = false;
  });

  // ── Retake scan button ────────────────────────────────────
  retakeBtn.addEventListener('click', async () => {
    const file = retakeFile.files[0]; if (!file) return;
    retakeBtn.disabled = true;
    retakeBtn.classList.add('spinning');
    try {
      const fd = new FormData(); fd.append('bill', file);
      const res  = await fetch('/scan-single', {method:'POST', body:fd});
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Server error');

      if (data.serial_number === 'UNREADABLE') {
        retakeHint.textContent = '⚠️ Still unreadable. Try better lighting or a closer shot.';
        retakePreview.classList.remove('show');
        retakePh.classList.remove('hide');
        retakeBtn.disabled = true;
        retakeFile.value = '';
        return;
      }

      bills[retakeIndex] = data;
      renderBills();
      retakeCard.classList.remove('show');
      checkForUnreadable();
    } catch(e) {
      showError(e.message);
    } finally {
      retakeBtn.classList.remove('spinning');
    }
  });

  // ── Render bill list ──────────────────────────────────────
  function renderBills() {
    billList.innerHTML = '';
    bills.forEach((b, i) => {
      const ok  = b.serial_number !== 'UNREADABLE';
      const row = document.createElement('div');
      row.className = 'bill-row ' + (ok ? 'ok' : 'bad');
      row.innerHTML =
        '<div class="bill-badge">' + (ok ? '✅' : '❌') + '</div>' +
        '<div class="bill-info">' +
          '<div class="bill-serial">' + (ok ? b.serial_number : 'UNREADABLE') + '</div>' +
          '<div class="bill-denom">$' + (b.denomination || '?') + '</div>' +
        '</div>' +
        '<div class="bill-status ' + (ok ? 'ok' : 'bad') + '">' + (ok ? 'OK' : 'RETAKE') + '</div>';
      billList.appendChild(row);
    });
    billCount.textContent = bills.length + ' bill' + (bills.length !== 1 ? 's' : '');
    resultsCard.classList.add('show');
  }

  // ── Check unreadable → retake or show scan more/done ─────
  function checkForUnreadable() {
    const idx = bills.findIndex(b => b.serial_number === 'UNREADABLE');
    if (idx !== -1) {
      retakeIndex = idx;
      const denom = bills[idx].denomination ? '$' + bills[idx].denomination : 'unknown denomination';
      retakeHint.textContent = 'Bill #' + (idx+1) + ' (' + denom + ') could not be read. Photograph it alone.';
      retakePreview.classList.remove('show');
      retakePh.classList.remove('hide');
      retakeBtn.disabled = true;
      if (retakeFile) retakeFile.value = '';
      retakeCard.classList.add('show');
      moreZone.classList.remove('show');
      scanMoreSection.style.display = 'none';
    } else {
      // All bills OK — show Scan More / Done buttons
      retakeCard.classList.remove('show');
      moreZone.classList.remove('show');
      scanMoreSection.style.display = 'flex';
    }
  }

  // ── Finalize → build string, send to PC ──────────────────
  function finalize() {
    const str = bills.map(b => '$' + b.denomination + ' : ' + b.serial_number).join(' || ');
    clipboardStr.textContent = str;
    scanMoreSection.style.display = 'none';
    successCard.classList.add('show');
    fetch('/push-clipboard', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({clipboard: str, bills})
    });
  }

  function hide(els) { els.forEach(e => e.classList.remove('show')); }
  function showError(msg) { errorMsg.textContent = '❌ ' + msg; errorMsg.classList.add('show'); }
</script>
</body>
</html>`;



// ── PC RECEIVER HTML ──────────────────────────────────────────
const PC_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>💵 PC Receiver</title>
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;700;800&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<style>
  :root{--g:#00C853;--g2:#00E676;--dark:#0A0F0A;--card:#111811;--bd:#1E2E1E;--tx:#E8F5E9;--mu:#557755;--gold:#FFD600;}
  *{margin:0;padding:0;box-sizing:border-box;}
  body{background:var(--dark);color:var(--tx);font-family:'Syne',sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;}
  body::before{content:'';position:fixed;inset:0;background-image:linear-gradient(rgba(0,200,83,.04) 1px,transparent 1px),linear-gradient(90deg,rgba(0,200,83,.04) 1px,transparent 1px);background-size:40px 40px;pointer-events:none;}
  .wrap{position:relative;z-index:1;width:100%;max-width:580px;padding:40px 32px;display:flex;flex-direction:column;gap:24px;}
  .logo{font-size:11px;font-family:'JetBrains Mono',monospace;color:var(--g);letter-spacing:.2em;text-transform:uppercase;}
  h1{font-size:42px;font-weight:800;background:linear-gradient(135deg,#fff 40%,var(--g2));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;line-height:1.1;}
  .sub{font-size:12px;color:var(--mu);font-family:'JetBrains Mono',monospace;}

  .how{background:var(--card);border:1px solid var(--bd);border-radius:14px;padding:18px 22px;display:flex;flex-direction:column;gap:10px;}
  .how-title{font-size:10px;font-family:'JetBrains Mono',monospace;letter-spacing:.15em;text-transform:uppercase;color:var(--mu);}
  .step{display:flex;gap:10px;align-items:flex-start;font-size:13px;line-height:1.5;}
  .sn{width:22px;height:22px;border-radius:50%;background:var(--g);color:#000;font-weight:800;font-size:11px;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px;}

  .live{background:var(--card);border:2px solid var(--bd);border-radius:16px;padding:28px 24px;text-align:center;min-height:160px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;transition:border-color .4s,box-shadow .4s;}
  .live.flash{border-color:var(--g);box-shadow:0 0 50px rgba(0,200,83,.2);animation:flash .6s ease;}
  @keyframes flash{0%{box-shadow:0 0 0 rgba(0,200,83,0)}50%{box-shadow:0 0 70px rgba(0,200,83,.4)}100%{box-shadow:0 0 50px rgba(0,200,83,.2)}}
  .wait{font-family:'JetBrains Mono',monospace;font-size:13px;color:var(--mu);}
  .clip-display{font-family:'JetBrains Mono',monospace;font-size:15px;font-weight:600;color:var(--g2);word-break:break-all;line-height:1.7;text-align:left;width:100%;}
  .copied-pill{background:#0A2010;border:1px solid var(--g);border-radius:8px;padding:6px 14px;font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--g2);}
  .bill-count{font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--mu);}

  .conn{display:flex;align-items:center;gap:8px;font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--mu);}
  .dot{width:7px;height:7px;border-radius:50%;background:var(--g);animation:pulse 2s infinite;}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}

  .history{display:flex;flex-direction:column;gap:8px;}
  .history-title{font-size:10px;font-family:'JetBrains Mono',monospace;letter-spacing:.15em;text-transform:uppercase;color:var(--mu);}
  .history-list{display:flex;flex-direction:column;gap:6px;max-height:180px;overflow-y:auto;}
  .history-item{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:10px 14px;font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--tx);word-break:break-all;animation:up .25s ease;}
  @keyframes up{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
  .empty{font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--mu);text-align:center;padding:14px;}
</style>
</head>
<body>
<nav style="background:#1a1a2e;padding:10px 20px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;position:sticky;top:0;z-index:999;">
  <span style="color:#00C853;font-weight:800;font-size:14px;margin-right:8px;">💵 Petty Cash</span>
  <a href="/voucher" style="color:#ccc;text-decoration:none;font-size:13px;font-weight:600;padding:6px 12px;border-radius:6px;">📋 OEC Voucher</a>
  <a href="/custom"  style="color:#ccc;text-decoration:none;font-size:13px;font-weight:600;padding:6px 12px;border-radius:6px;">✏️ Custom Voucher</a>
  <a href="/pc"      style="color:#ccc;text-decoration:none;font-size:13px;font-weight:600;padding:6px 12px;border-radius:6px;">🖥️ PC Receiver</a>
  <a href="/"        style="color:#ccc;text-decoration:none;font-size:13px;font-weight:600;padding:6px 12px;border-radius:6px;">📱 Bill Scanner</a>
  <a href="/sign"    style="color:#ccc;text-decoration:none;font-size:13px;font-weight:600;padding:6px 12px;border-radius:6px;">✍️ Signature</a>
</nav>
<div class="wrap">
  <div>
    <div class="logo">🖥️ PC Receiver</div>
    <h1>Clipboard<br>Ready</h1>
    <p class="sub">// waiting for batch scans</p>
  </div>

  <div class="how">
    <div class="how-title">Workflow</div>
    <div class="step"><div class="sn">1</div><div>Lay all bills flat — serial numbers facing up</div></div>
    <div class="step"><div class="sn">2</div><div>Take 1 photo of all bills on your phone</div></div>
    <div class="step"><div class="sn">3</div><div>Tap <strong>Scan All Bills</strong> — Groq reads every serial at once</div></div>
    <div class="step"><div class="sn">4</div><div>Clipboard auto-filled on this PC → <strong>Ctrl+V</strong> into Word ✨</div></div>
  </div>

  <div class="live" id="live">
    <div class="wait" id="waitText">⏳ Waiting for phone scan...</div>
    <div class="clip-display" id="clipDisplay" style="display:none"></div>
    <div class="copied-pill" id="copiedPill" style="display:none">📋 Copied to clipboard — Ctrl+V in Word</div>
    <div class="bill-count" id="billCount" style="display:none"></div>
  </div>

  <div class="conn"><div class="dot"></div><span>Connected · listening for scans</span></div>

  <div class="history">
    <div class="history-title">📋 Session History</div>
    <div class="history-list" id="historyList"><div class="empty">Nothing yet</div></div>
  </div>
</div>

<script>
  const live        = document.getElementById('live');
  const waitText    = document.getElementById('waitText');
  const clipDisplay = document.getElementById('clipDisplay');
  const copiedPill  = document.getElementById('copiedPill');
  const billCount   = document.getElementById('billCount');
  const historyList = document.getElementById('historyList');

  const evtSource = new EventSource('/events');

  evtSource.onmessage = async (e) => {
    const data = JSON.parse(e.data);
    const str  = data.clipboard;
    const cnt  = data.bills ? data.bills.length : 0;

    // Copy to clipboard
    try {
      await navigator.clipboard.writeText(str);
    } catch (_) {
      // Fallback for older browsers
      const ta = document.createElement('textarea');
      ta.value = str;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }

    // Flash and show
    live.classList.add('flash');
    setTimeout(() => live.classList.remove('flash'), 1500);

    waitText.style.display    = 'none';
    clipDisplay.style.display = 'block';
    copiedPill.style.display  = 'block';
    billCount.style.display   = 'block';
    clipDisplay.textContent   = str;
    billCount.textContent     = cnt + ' bill' + (cnt !== 1 ? 's' : '') + ' scanned';

    // Add to history
    if (historyList.querySelector('.empty')) historyList.innerHTML = '';
    const item = document.createElement('div');
    item.className = 'history-item';
    item.textContent = str;
    historyList.insertBefore(item, historyList.firstChild);
  };

  evtSource.onerror = () => console.warn('SSE reconnecting...');
</script>
<script>
(function() {
  var path = window.location.pathname;
  var links = document.querySelectorAll('nav a');
  links.forEach(function(a) {
    if (a.getAttribute('href') === path) {
      a.style.background = '#00C853';
      a.style.color = '#000';
    }
  });
})();
</script>
</body>
</html>`;


// ── VOUCHER HTML — loaded from voucher.html ─────────────────────
function getVoucherHTML() {
  const voucherPath = path.join(__dirname, 'voucher.html');
  try {
    return fs.readFileSync(voucherPath, 'utf8');
  } catch(e) {
    return '<h1 style="font-family:sans-serif;padding:40px">Error: voucher.html not found in the same folder as server.js</h1>';
  }
}

// ── HTTP SERVER ───────────────────────────────────────────────
const server = http.createServer(async (req, res) => {

  // Phone page
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(PHONE_HTML);
  }

  // PC receiver page
  if (req.method === 'GET' && req.url === '/pc') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(PC_HTML);
  }

  // SSE — PC browser subscribes for push events
  if (req.method === 'GET' && req.url === '/events') {
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    res.write(': connected\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // Batch scan — phone posts group photo
  if (req.method === 'POST' && req.url === '/scan-batch') {
    try {
      const { imageData, mimeType } = await parseMultipart(req);
      const base64 = imageData.toString('base64');
      const bills  = await callGroqBatch(base64, mimeType);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(bills));
    } catch (err) {
      console.error('Batch scan error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Single retake scan
  if (req.method === 'POST' && req.url === '/scan-single') {
    try {
      const { imageData, mimeType } = await parseMultipart(req);
      const base64 = imageData.toString('base64');
      const bill   = await callGroqSingle(base64, mimeType);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(bill));
    } catch (err) {
      console.error('Single scan error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Phone pushes final clipboard string to PC
  if (req.method === 'POST' && req.url === '/push-clipboard') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        pushToPC(data.clipboard, data.bills);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Bad JSON' }));
      }
    });
    return;
  }

  // Voucher web app
  if (req.method === 'GET' && req.url === '/voucher') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(getVoucherHTML());
  }

  // Voucher: get current serial from file
  if (req.method === 'GET' && req.url === '/get-serial') {
    try {
      if (fs.existsSync(SERIAL_FILE)) {
        const serial = fs.readFileSync(SERIAL_FILE, 'utf8').trim();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ serial, found: true }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ serial: '', found: false }));
      }
    } catch(e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Mobile signature pad page
  if (req.method === 'GET' && req.url === '/sign') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(fs.readFileSync(path.join(__dirname, 'sign.html'), 'utf8'));
  }

  // Phone posts signature (base64 PNG)
  if (req.method === 'POST' && req.url === '/submit-signature') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        lastSignature = data.signature || null;
        console.log('  ✍️  Signature received from phone');
        // Push to any open voucher pages via SSE
        const msg = JSON.stringify({ type: 'signature', signature: lastSignature });
        for (const client of sseClients) {
          try { client.write(`data: ${msg}\n\n`); } catch(_) { sseClients.delete(client); }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Bad JSON' }));
      }
    });
    return;
  }

  // Voucher page polls for latest signature
  if (req.method === 'GET' && req.url === '/get-signature') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ signature: lastSignature, found: !!lastSignature }));
    return;
  }

  // Clear signature after use
  if (req.method === 'POST' && req.url === '/clear-signature') {
    lastSignature = null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Custom voucher page
  if (req.method === 'GET' && req.url === '/custom') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(fs.readFileSync(path.join(__dirname, 'custom-voucher.html'), 'utf8'));
  }

  res.writeHead(404);
  res.end('Not found');
});

// ── CLEANUP OLD SERIAL FILE ON STARTUP ───────────────────────
try {
  if (fs.existsSync(SERIAL_FILE)) {
    fs.unlinkSync(SERIAL_FILE);
    console.log('  🗑️  Cleared old serial_scan.txt from previous session');
  }
} catch (e) {
  console.warn('  ⚠️  Could not clear serial file:', e.message);
}

// ── START ─────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  const ifaces = os.networkInterfaces();
  let localIP  = 'YOUR-PC-IP';
  for (const iface of Object.values(ifaces)) {
    for (const alias of iface) {
      if (alias.family === 'IPv4' && !alias.internal) { localIP = alias.address; break; }
    }
  }

  console.log('\n💵 Petty Cash System\n');
  console.log(`  🖥️  PC receiver:      http://localhost:${PORT}/pc`);
  console.log(`  📋  Voucher:          http://localhost:${PORT}/voucher`);
  console.log(`  📋  Custom Voucher:   http://localhost:${PORT}/custom`);
  console.log(`  📱  Bill Scanner:     http://${localIP}:${PORT}`);
  console.log(`  ✍️   Signature Pad:    http://${localIP}:${PORT}/sign`);
  console.log('\n  Steps:');
  console.log('    1. Open PC receiver page in your browser');
  console.log('    2. Open phone scanner URL on your phone');
  console.log('    3. Lay bills flat, take 1 photo');
  console.log('    4. Scan → clipboard auto-filled → Ctrl+V in Word\n');

  if (GROQ_API_KEY === 'YOUR_GROQ_API_KEY') {
    console.warn('  ⚠️  Add your Groq API key on line 32, or:');
    console.warn('     set GROQ_API_KEY=gsk_xxxx        (CMD)');
    console.warn('     $env:GROQ_API_KEY="gsk_xxxx"     (PowerShell)\n');
  }
});
// ── VOUCHER HTML — loaded from voucher.html file ─────────────
function getVoucherHTML() {
  const voucherPath = path.join(__dirname, 'voucher.html');
  try {
    return fs.readFileSync(voucherPath, 'utf8');
  } catch(e) {
    return '<h1>voucher.html not found in same folder as server.js</h1>';
  }
}

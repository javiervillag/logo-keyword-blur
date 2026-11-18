// Open a page with NO extension, then install the extension into the running browser
// and check the already-open page starts blurring without a reload.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ext = process.argv[2] || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chromeBin = path.join(homedir(), 'Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn('python3', ['-m', 'http.server', '8766', '--bind', '127.0.0.1'], { cwd: path.join(ext, 'test'), stdio: 'ignore' });
const chrome = spawn(chromeBin, ['--headless=new', '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
  `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'lb-late-'))}`, '--no-first-run', 'about:blank'],
  { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
const out = chrome.stdio[3], inp = chrome.stdio[4];
let id = 0, buf = ''; const pending = new Map();
inp.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\0')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } } });
const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); out.write(JSON.stringify({ id: i, method, params, sessionId }) + '\0'); setTimeout(() => pending.delete(i) && rej(new Error('timeout ' + method)), 20000); });
const evalIn = async (s, expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, s)).result.value;
try {
  await sleep(1500);
  const { targetId } = await send('Target.createTarget', { url: 'http://127.0.0.1:8766/fixture.html' });
  const { sessionId: page } = await send('Target.attachToTarget', { targetId, flatten: true });
  await sleep(1500);
  const before = await evalIn(page, `document.querySelectorAll('[data-lb-blur], span[data-lb-kw]').length`);
  const { id: extId } = await send('Extensions.loadUnpacked', { path: ext });
  let sw;
  for (let i = 0; i < 30 && !sw; i++) { await sleep(200); const { targetInfos } = await send('Target.getTargets'); sw = targetInfos.find((t) => t.url === `chrome-extension://${extId}/src/background.js`); }
  const { sessionId: s } = await send('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
  await send('Runtime.runIfWaitingForDebugger', {}, s).catch(() => {});
  await evalIn(s, `new Promise(r => chrome.storage.sync.set({settings: {keywords: ['Globex', 'worked']}}, r))`);
  await sleep(1500);
  const after = await evalIn(page, `({ logos: document.querySelectorAll('[data-lb-blur]').length, words: [...document.querySelectorAll('span[data-lb-kw]')].map(x => x.textContent) })`);
  console.log(JSON.stringify({ before, after }));
  console.log(after.logos > 0 && after.words.includes('worked') ? 'PASS' : 'FAIL');
} finally { chrome.kill(); server.kill(); }

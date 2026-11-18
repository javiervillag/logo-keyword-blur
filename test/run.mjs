// End-to-end test: loads the real unpacked extension into Chrome for Testing (headless),
// opens a page, and checks what got blurred. Uses only Node built-ins (Node 22+).
//
//   node test/run.mjs                       -> runs test/fixture.html checks
//   node test/run.mjs https://example.com   -> screenshots live sites into test/out/
//
// CHROME env var can point at a Chromium / Chrome for Testing binary (branded Chrome
// no longer accepts --load-extension).
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const extDir = path.resolve(here, '..');
const outDir = path.join(here, 'out');
mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const base = path.join(homedir(), 'Library/Caches/ms-playwright');
  const dirs = existsSync(base) ? readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse() : [];
  for (const d of dirs) {
    for (const p of ['chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
      if (existsSync(path.join(base, d, p))) return path.join(base, d, p);
    }
  }
  throw new Error('No Chromium found. Set CHROME=/path/to/chromium');
}

// ---- tiny CDP client ----
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = [];
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) { const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
      else this.events.push(m);
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      setTimeout(() => { if (this.pending.delete(id)) rej(new Error(`CDP timeout: ${method}`)); }, 20000);
    });
  }
  async eval(sessionId, expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500));
    return r.result.value;
  }
}

async function launch() {
  const profile = mkdtempSync(path.join(tmpdir(), 'lb-profile-'));
  const port = 9300 + Math.floor(Math.random() * 500);
  const chrome = spawn(findChrome(), [
    '--headless=new', '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    `--load-extension=${extDir}`, `--disable-extensions-except=${extDir}`,
    '--no-first-run', '--no-default-browser-check', '--window-size=1280,1000', 'about:blank'
  ], { stdio: 'ignore' });
  let ver;
  for (let i = 0; i < 50 && !ver; i++) {
    await sleep(200);
    ver = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json()).catch(() => null);
  }
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  return { chrome, cdp: new CDP(ws) };
}

async function extensionSession(cdp) {
  for (let i = 0; i < 30; i++) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const sw = targetInfos.find((t) => t.type === 'service_worker' && t.url.endsWith('/src/background.js'));
    if (sw) {
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
      await cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
      await sleep(300);
      return sessionId;
    }
    await sleep(200);
  }
  throw new Error('Extension service worker not found — did the extension load?');
}

async function setSettings(cdp, sw, patch) {
  await cdp.eval(sw, `new Promise(r => chrome.storage.sync.get({settings:{}}, res =>
    chrome.storage.sync.set({settings: Object.assign({}, res.settings, ${JSON.stringify(patch)})}, r)))`);
}

async function openPage(cdp, url) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);
  await cdp.send('Page.navigate', { url }, sessionId);
  return sessionId;
}

async function shot(cdp, s, file) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, s);
  writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
}

// ---- fixture test ----
async function fixtureTest(cdp, sw) {
  const server = spawn('python3', ['-m', 'http.server', '8765', '--bind', '127.0.0.1'], { cwd: here, stdio: 'ignore' });
  await sleep(800);
  try {
    await setSettings(cdp, sw, { enabled: true, blurLogos: true, blurKeywords: true, wholeWord: true,
      caseSensitive: false, strength: 8, keywords: ['Globex', 'Initech', 'Massive Dynamic'], disabledSites: [] });
    const s = await openPage(cdp, 'http://127.0.0.1:8765/fixture.html');
    await sleep(2000);
    const check = await cdp.eval(s, `(() => {
      const marked = (e) => !!e.closest('[data-lb-blur]');
      const short = (e) => e.outerHTML.slice(0, 300);
      const card = document.getElementById('card');
      const spans = [...document.querySelectorAll('span[data-lb-kw]')];
      return {
        missedLogos: [...document.querySelectorAll('[data-expect=blur]')].filter(e => !marked(e)).map(short),
        wronglyBlurred: [...document.querySelectorAll('[data-expect=clear]')].filter(marked).map(short),
        allBlurred: [...document.querySelectorAll('[data-lb-blur]')].map(short),
        keywordSpans: spans.map(s => s.textContent),
        shadowSpans: card.shadowRoot ? [...card.shadowRoot.querySelectorAll('span[data-lb-kw]')].map(s => s.textContent) : 'no shadow root',
        editorTouched: document.querySelectorAll('#editor span[data-lb-kw]').length,
        dynamic: { text: document.getElementById('dyn').textContent, spans: [...document.querySelectorAll('#dyn span[data-lb-kw]')].map(s => s.textContent) },
        spanFilter: spans[0] && getComputedStyle(spans[0]).filter,
        logoFilter: getComputedStyle(document.getElementById('brand-img')).filter,
        wordmarkFilter: getComputedStyle(document.getElementById('wordmark')).filter,
        wordmarkMask: getComputedStyle(document.getElementById('wordmark')).maskImage,
        p1: document.getElementById('p1').textContent,
        title: document.title,
        gateGone: !document.querySelector('style') || getComputedStyle(document.documentElement).visibility
      };
    })()`);
    await shot(cdp, s, path.join(outDir, 'fixture-on.png'));

    await setSettings(cdp, sw, { enabled: false });
    await sleep(500);
    const off = await cdp.eval(s, `({
      marks: document.querySelectorAll('[data-lb-blur], span[data-lb-kw]').length,
      p1Nodes: document.getElementById('p1').childNodes.length,
      p1: document.getElementById('p1').textContent,
      dynNodes: document.getElementById('dyn').childNodes.length,
      dyn: document.getElementById('dyn').textContent,
      title: document.title
    })`);
    // A page that changes its own title later (SPAs do) gets masked again.
    await setSettings(cdp, sw, { enabled: true });
    await sleep(400);
    const retitle = await cdp.eval(s, `new Promise(r => { document.title = 'Inbox: Initech update'; setTimeout(() => r(document.title), 200); })`);
    await shot(cdp, s, path.join(outDir, 'fixture-off.png'));
    // "Only these brands": only Acme and Umbrella logos should blur.
    await setSettings(cdp, sw, { enabled: true, logoMode: 'list', logoNames: ['Acme', 'Umbrella'], blurKeywords: false });
    await sleep(600);
    const list = await cdp.eval(s, `[...document.querySelectorAll('[data-lb-blur]')].map(e => e.getAttribute('data-lb-blur') + ' :: ' + (e.getAttribute('alt') || e.getAttribute('class') || e.localName))`);
    await shot(cdp, s, path.join(outDir, 'fixture-brands.png'));
    await setSettings(cdp, sw, { logoMode: 'all', logoNames: [], blurKeywords: true });
    return { check, off, list, retitle };
  } finally { server.kill(); }
}

async function liveSites(cdp, sw, urls) {
  await setSettings(cdp, sw, { enabled: true, blurLogos: true, blurKeywords: true, disabledSites: [] });
  const results = [];
  for (const url of urls) {
    console.error('opening', url);
    const s = await openPage(cdp, url).catch((e) => { console.error(e.message); return null; });
    if (!s) { results.push({ url, error: 'could not open' }); continue; }
    await sleep(6000);
    console.error('evaluating', url);
    const r = await cdp.eval(s, `(() => {
      let logos = 0, kws = 0; const roots = [document];
      for (let i = 0; i < roots.length; i++) {
        logos += roots[i].querySelectorAll('[data-lb-blur]').length;
        kws += roots[i].querySelectorAll('span[data-lb-kw]').length;
        roots[i].querySelectorAll('*').forEach(e => e.shadowRoot && roots.push(e.shadowRoot));
      }
      return { url: location.href, logos, kws, sample: [...document.querySelectorAll('[data-lb-blur]')].slice(0, 12).map(e => e.getAttribute('data-lb-blur') + ' :: ' + (e.naturalWidth !== undefined ? '[' + e.naturalWidth + 'x' + e.naturalHeight + ' ' + (e.currentSrc || '').slice(-40) + '] ' : '') + e.outerHTML.slice(0, 160)) };
    })()`).catch((e) => ({ url, error: e.message }));
    const name = new URL(url).hostname.replace(/\W+/g, '_');
    r.screenshot = await shot(cdp, s, path.join(outDir, `${name}.png`)).catch(() => null);
    results.push(r);
  }
  return results;
}

const { chrome, cdp } = await launch();
try {
  const sw = await extensionSession(cdp);
  const urls = process.argv.slice(2);
  if (urls[0] === '--popup') {
    // Render the popup as a page and add a keyword through its form.
    const { targetInfos } = await cdp.send('Target.getTargets');
    const id = new URL(targetInfos.find((t) => t.url.endsWith('/src/background.js')).url).host;
    await setSettings(cdp, sw, { keywords: ['Acme Corp', 'Globex'], blurLogos: true, logoMode: 'list', logoNames: ['Nike', 'Coca-Cola'] });
    const s = await openPage(cdp, `chrome-extension://${id}/popup/popup.html`);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 340, height: 860, deviceScaleFactor: 2, mobile: false }, s);
    await sleep(800);
    await cdp.eval(s, `document.getElementById('kwInput').value = 'Initech, Hooli'; document.getElementById('addForm').requestSubmit();`);
    await cdp.eval(s, `document.getElementById('kwManyOpen').click(); const t = document.getElementById('kwManyText'); t.value = 'Vandelay\\nInitrode\\nAcme, Inc.\\nglobex'; t.dispatchEvent(new Event('input'));`);
    await sleep(200);
    await shot(cdp, s, path.join(outDir, 'popup-addmany.png'));
    await cdp.eval(s, `document.getElementById('kwManyAdd').click()`);
    await sleep(400);
    await sleep(500);
    const saved = await cdp.eval(sw, `new Promise(r => chrome.storage.sync.get({settings:{}}, x => r(x.settings.keywords)))`);
    const hidden = await shot(cdp, s, path.join(outDir, 'popup.png'));
    const leaks = await cdp.eval(s, `['Nike','Coca-Cola','Globex','Initech'].filter(n => document.body.innerText.includes(n))`);
    await cdp.eval(s, `document.getElementById('brandInput').value = 'Adid'; document.getElementById('brandInput').focus(); getComputedStyle(document.getElementById('brandInput')).webkitTextSecurity`).then((v) => console.error('typing style:', v));
    await shot(cdp, s, path.join(outDir, 'popup-typing.png'));
    await cdp.eval(s, `document.querySelector('.eye[data-list=keywords]').click()`);
    await sleep(200);
    const shown = await shot(cdp, s, path.join(outDir, 'popup-revealed.png'));
    console.log(JSON.stringify({ savedKeywords: saved, namesVisibleWhileHidden: leaks, hidden, shown }));
  } else if (urls.length) {
    const kw = process.env.KEYWORDS ? process.env.KEYWORDS.split(',') : [];
    if (kw.length) await setSettings(cdp, sw, { keywords: kw });
    const brands = process.env.LOGO_NAMES ? process.env.LOGO_NAMES.split(',') : [];
    await setSettings(cdp, sw, brands.length ? { logoMode: 'list', logoNames: brands } : { logoMode: 'all', logoNames: [] });
    console.log(JSON.stringify(await liveSites(cdp, sw, urls), null, 2));
  } else {
    const r = await fixtureTest(cdp, sw);
    console.log(JSON.stringify(r, null, 2));
    const ok = !r.check.missedLogos.length && !r.check.wronglyBlurred.length && r.check.editorTouched === 0 &&
      r.off.marks === 0 && r.off.p1Nodes === 1 &&
      JSON.stringify(r.list.map((x) => x.split(' :: ')[1]).sort()) === JSON.stringify(['Acme', 'Umbrella', 'site-logo text-logo']) &&
      r.list.every((x) => x.startsWith('brand ::')) &&
      r.check.title === '••• blur test page' && r.off.title === 'Globex blur test page' &&
      r.retitle === 'Inbox: ••• update' && /blur/.test(r.check.wordmarkFilter) && r.check.wordmarkMask === 'none';
    console.log(ok ? '\nPASS' : '\nFAIL');
    process.exitCode = ok ? 0 : 1;
  }
} finally {
  cdp.ws.close();
  chrome.kill();
}

/* global lbLoadSettings, lbSaveSettings, lbHostKey */
const $ = (id) => document.getElementById(id);
let settings;
let host = '';
let tabId = null;
// Saved names start hidden every time the popup opens, so a screen share never shows them by accident.
// Each list has its own eye button. What you type stays visible.
const revealed = { keywords: false, logoNames: false };
const EYE_OPEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_SHUT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.7 10.7 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7c1.9 0 3.5-.6 4.9-1.4"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';
const MASK = '•••••';

function save() { return lbSaveSettings(settings).then(refreshStats); }

// A text box + chip list bound to one array in settings (keywords, logoNames).
function chipEditor({ key, form, input, list, empty, prefix }) {
  // Adds new items, skipping duplicates (any case). Returns how many were new.
  function addItems(items) {
    const lower = new Set(settings[key].map((k) => k.toLowerCase()));
    let added = 0;
    items.map((s) => s.trim()).filter(Boolean).forEach((k) => {
      if (!lower.has(k.toLowerCase())) { settings[key].push(k); lower.add(k.toLowerCase()); added++; }
    });
    if (added) { render(); save(); }
    return added;
  }
  function add(raw) {
    addItems(raw.split(/[,\n]/));
    $(input).value = '';
  }

  // "Add many…": a box for one item per line (commas allowed inside, e.g. "Acme, Inc.").
  const box = $(prefix + 'Many'), text = $(prefix + 'ManyText'), count = $(prefix + 'ManyCount');
  const lines = () => text.value.split('\n').map((s) => s.trim()).filter(Boolean);
  const close = () => { box.hidden = true; $(prefix + 'ManyOpen').hidden = false; text.value = ''; count.textContent = ''; };
  $(prefix + 'ManyOpen').addEventListener('click', () => { box.hidden = false; $(prefix + 'ManyOpen').hidden = true; text.focus(); });
  text.addEventListener('input', () => { const n = lines().length; count.textContent = n ? `${n} to add` : ''; });
  $(prefix + 'ManyCancel').addEventListener('click', close);
  $(prefix + 'ManyAdd').addEventListener('click', () => {
    const n = lines().length;
    const added = addItems(lines());
    close();
    $(prefix + 'ManyOpen').textContent = added === n ? `Added ${added}. Add more…` : `Added ${added} (${n - added} already there). Add more…`;
  });
  text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $(prefix + 'ManyAdd').click(); });
  $(form).addEventListener('submit', (e) => { e.preventDefault(); add($(input).value); });
  // A pasted multi-line list would lose its newlines in a one-line input; add it directly.
  $(input).addEventListener('paste', (e) => {
    const text = e.clipboardData.getData('text');
    if (/[\n,]/.test(text)) { e.preventDefault(); add(text); }
  });
  return function draw() {
    const ul = $(list);
    ul.textContent = '';
    settings[key].forEach((item) => {
      const li = document.createElement('li');
      li.append(revealed[key] ? item : MASK);
      li.classList.toggle('masked', !revealed[key]);
      const x = document.createElement('button');
      x.type = 'button';
      x.textContent = '×';
      x.title = revealed[key] ? 'Remove ' + item : 'Remove';
      x.addEventListener('click', () => {
        settings[key] = settings[key].filter((k) => k !== item);
        render(); save();
      });
      li.append(x);
      ul.append(li);
    });
    $(empty).hidden = settings[key].length > 0;
  };
}

let drawKeywords = () => {};
let drawBrands = () => {};

function render() {
  document.querySelectorAll('.eye').forEach((b) => {
    const key = b.dataset.list;
    const label = key === 'keywords' ? 'keywords' : 'brand names';
    b.innerHTML = revealed[key] ? EYE_OPEN : EYE_SHUT;
    b.setAttribute('aria-pressed', String(revealed[key]));
    b.title = (revealed[key] ? 'Hide ' : 'Show ') + label;
    b.setAttribute('aria-label', b.title);
    b.hidden = settings[key].length === 0;
  });
  $('enabled').checked = settings.enabled;
  $('main').classList.toggle('off', !settings.enabled);
  $('blurLogos').checked = settings.blurLogos;
  $('logoModeBox').hidden = !settings.blurLogos;
  document.querySelectorAll('input[name="logoMode"]').forEach((r) => { r.checked = r.value === settings.logoMode; });
  $('brandBox').hidden = settings.logoMode !== 'list';
  $('blurKeywords').checked = settings.blurKeywords;
  $('wholeWord').checked = settings.wholeWord;
  $('caseSensitive').checked = settings.caseSensitive;
  $('strength').value = settings.strength;
  $('strengthOut').textContent = settings.strength + 'px';
  drawKeywords();
  drawBrands();
}

let injectTried = false;
function refreshStats() {
  const out = $('stats');
  if (tabId == null) { out.textContent = ''; return; }
  // Give the page a moment to re-apply new settings before counting.
  setTimeout(() => {
    chrome.tabs.sendMessage(tabId, { type: 'lb:stats' }, (res) => {
      if (chrome.runtime.lastError || !res) {
        if (!host) { out.textContent = 'Chrome doesn’t allow extensions on this page.'; return; }
        if (injectTried) { out.textContent = 'Couldn’t start on this tab. Try reloading it.'; return; }
        // Tab was open before the extension loaded: start it now instead of asking for a reload.
        injectTried = true;
        out.textContent = 'Starting on this tab…';
        chrome.runtime.sendMessage({ type: 'lb:inject', tabId }, () => { void chrome.runtime.lastError; setTimeout(refreshStats, 300); });
        return;
      }
      if (!res.active) { out.textContent = 'Not blurring on this page.'; return; }
      const l = res.logos === 1 ? 'logo' : 'logos';
      const k = res.keywords === 1 ? 'keyword match' : 'keyword matches';
      out.textContent = `Blurring ${res.logos} ${l} and ${res.keywords} ${k} on this page.`;
    });
  }, 150);
}

function bindToggle(id, key) {
  $(id).addEventListener('change', (e) => { settings[key] = e.target.checked; render(); save(); });
}

async function init() {
  settings = await lbLoadSettings();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    tabId = tab.id;
    try {
      const u = new URL(tab.url || '');
      if (/^https?:$/.test(u.protocol)) host = lbHostKey(u.hostname);
    } catch (e) { host = ''; }
  }

  drawKeywords = chipEditor({ key: 'keywords', form: 'addForm', input: 'kwInput', list: 'kwList', empty: 'kwEmpty', prefix: 'kw' });
  drawBrands = chipEditor({ key: 'logoNames', form: 'brandForm', input: 'brandInput', list: 'brandList', empty: 'brandEmpty', prefix: 'brand' });
  render();
  refreshStats();

  document.querySelectorAll('.eye').forEach((b) => b.addEventListener('click', () => {
    revealed[b.dataset.list] = !revealed[b.dataset.list];
    render();
  }));

  bindToggle('enabled', 'enabled');
  bindToggle('blurLogos', 'blurLogos');
  bindToggle('blurKeywords', 'blurKeywords');
  bindToggle('wholeWord', 'wholeWord');
  bindToggle('caseSensitive', 'caseSensitive');

  document.querySelectorAll('input[name="logoMode"]').forEach((r) => r.addEventListener('change', (e) => {
    settings.logoMode = e.target.value;
    render(); save();
    if (settings.logoMode === 'list') $('brandInput').focus();
  }));

  let strengthTimer;
  $('strength').addEventListener('input', (e) => {
    settings.strength = Number(e.target.value);
    $('strengthOut').textContent = settings.strength + 'px';
    clearTimeout(strengthTimer);
    strengthTimer = setTimeout(save, 200);   // storage.sync has write limits; don't save every pixel
  });

  $('kwInput').focus();
}

init();

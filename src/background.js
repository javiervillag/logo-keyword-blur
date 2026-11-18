/* global LB_DEFAULTS, lbLoadSettings, lbSaveSettings */
importScripts('settings.js');

function updateBadge(settings) {
  chrome.action.setBadgeText({ text: settings.enabled ? '' : 'OFF' });
  chrome.action.setBadgeBackgroundColor({ color: '#6b7280' });
}

// Tabs opened before install/update don't get content scripts until reloaded. Inject them now.
async function injectInto(tabId, allFrames = true) {
  const target = { tabId, allFrames };
  await chrome.scripting.executeScript({ target, files: ['src/shadow-hook.js'], world: 'MAIN', injectImmediately: true });
  await chrome.scripting.executeScript({ target, files: ['src/settings.js', 'src/content.js'], injectImmediately: true });
}

async function injectOpenTabs() {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*', 'file:///*'] });
  await Promise.all(tabs.map((t) => injectInto(t.id).catch(() => {})));   // some pages (Web Store) refuse
}

chrome.runtime.onInstalled.addListener(() => { lbLoadSettings().then(updateBadge); injectOpenTabs(); });

// The popup asks for this when the current tab has no content script.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'lb:inject' && msg.tabId != null) {
    injectInto(msg.tabId).then(() => sendResponse(true), () => sendResponse(false));
    return true;
  }
});
chrome.runtime.onStartup.addListener(() => lbLoadSettings().then(updateBadge));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.settings) {
    updateBadge(Object.assign({}, LB_DEFAULTS, changes.settings.newValue || {}));
  }
});

// Alt+Shift+B flips the master switch on every tab at once.
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-blur') return;
  const s = await lbLoadSettings();
  s.enabled = !s.enabled;
  await lbSaveSettings(s);
});

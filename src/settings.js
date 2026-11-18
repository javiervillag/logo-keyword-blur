// Shared settings shape. Loaded by the content script, popup and background worker.
/* exported LB_DEFAULTS, lbLoadSettings, lbSaveSettings, lbHostKey */
var LB_DEFAULTS = {
  enabled: true,        // master switch (Alt+Shift+B)
  blurLogos: true,
  logoMode: 'all',      // 'all' = every detected logo, 'list' = only brands in logoNames
  logoNames: [],        // brand names for 'list' mode, e.g. ["Nike", "Coca-Cola"]
  blurKeywords: true,
  keywords: [],         // strings or phrases
  wholeWord: true,
  caseSensitive: false,
  strength: 8,          // blur radius in px
  disabledSites: []     // hostnames without "www."
};

function lbLoadSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get({ settings: {} }, (res) => {
      resolve(Object.assign({}, LB_DEFAULTS, (res && res.settings) || {}));
    });
  });
}

function lbSaveSettings(settings) {
  return new Promise((resolve) => chrome.storage.sync.set({ settings }, resolve));
}

function lbHostKey(hostname) {
  return String(hostname || '').toLowerCase().replace(/^www\./, '');
}

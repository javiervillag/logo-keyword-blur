/* global LB_DEFAULTS, lbLoadSettings, lbHostKey */
// Logo & Keyword Blur — content script.
// Marks logos with [data-lb-blur] and wraps keyword matches in <span data-lb-kw>.
// A stylesheet we inject blurs both. Everything is undone when blurring is turned off.
(() => {
  if (window.__lbLoaded) return;
  window.__lbLoaded = true;

  const ATTR_BLUR = 'data-lb-blur';
  const ATTR_KW = 'data-lb-kw';
  // The repeated attribute raises specificity so pages that set their own `filter: ... !important`
  // on a logo (e.g. a greyed-out "Powered by" mark) can't cancel the blur.
  // Masks and clip-paths are painted after filters, so a mask shaped like the logo would cut the
  // blur back into a sharp, readable outline. Drop them on anything we blur.
  const B = `[${ATTR_BLUR}]`, K = `[${ATTR_KW}]`;
  const RULES =
    `${B}${B}${B}${B}{filter:blur(var(--lb-blur,8px)) !important;` +
    `mask:none !important;-webkit-mask:none !important;clip-path:none !important;}` +
    `span${K}${K}${K}${K}{filter:blur(var(--lb-blur,8px)) !important;}`;

  // Elements that could be a logo, a logo container, or an icon-font brand icon.
  const CANDIDATES = [
    'img', 'svg', 'input[type="image" i]', 'object[data]', 'embed[src]', '[role="img"]',
    'i[class]', 'span[class*="icon" i]', 'span[class*="fa-" i]', 'span[class*="social" i]',
    '[class*="logo" i]', '[id*="logo" i]', '[class*="brand" i]', '[id*="brand" i]',
    '[class*="site-title" i]', '[class*="site-name" i]', '[class*="sitename" i]',
    '[aria-label*="logo" i]', '[title*="logo" i]', '[style*="url(" i]'
  ].join(',');

  // Whole class/id names that mean "the site's brand": navbar-brand, site-branding, site-title, brand-logo.
  // Matched per class name so design-system prefixes like "Primer_Brand__Button" don't count.
  const BRAND_CLASS = /^(?:[a-z0-9]+[-_])*(?:brand|brands|branding|brandmark|wordmark|site-?title|site-?name)(?:[-_](?:logo|mark|link|img|image|icon|wrap|wrapper|container))?$/i;
  const WALL_WORDS = new Set(['client', 'clients', 'partner', 'partners', 'sponsor', 'sponsors', 'customer',
    'customers', 'trusted', 'integrations', 'investors', 'backers', 'companies']);
  const AVATAR_WORDS = new Set(['avatar', 'avatars', 'profile', 'headshot', 'portrait', 'author', 'user', 'users',
    'person', 'people', 'team', 'photo', 'gravatar', 'member']);
  // Brand names that show up in icon classes and file names (fa-twitter, icon-linkedin, /icons/github.svg).
  const BRAND_NAMES = new Set(['fab', 'facebook', 'twitter', 'instagram', 'linkedin', 'youtube', 'tiktok',
    'pinterest', 'github', 'gitlab', 'discord', 'telegram', 'whatsapp', 'reddit', 'snapchat', 'dribbble',
    'behance', 'twitch', 'spotify', 'vimeo', 'tumblr', 'mastodon', 'bluesky', 'apple', 'android', 'google',
    'microsoft', 'amazon', 'paypal', 'stripe', 'visa', 'mastercard', 'amex', 'slack', 'skype', 'wechat',
    'weibo', 'xing', 'yelp', 'tripadvisor', 'producthunt', 'figma', 'dropbox', 'shopify', 'wordpress',
    'trustpilot', 'glassdoor', 'crunchbase', 'substack', 'patreon', 'soundcloud', 'messenger', 'threads']);
  const SOCIAL_HOSTS = ['facebook.com', 'fb.com', 'twitter.com', 'x.com', 'instagram.com', 'linkedin.com',
    'youtube.com', 'youtu.be', 'tiktok.com', 'pinterest.com', 'github.com', 'gitlab.com', 'discord.gg',
    'discord.com', 't.me', 'telegram.me', 'wa.me', 'whatsapp.com', 'reddit.com', 'threads.net',
    'snapchat.com', 'medium.com', 'dribbble.com', 'behance.net', 'twitch.tv', 'spotify.com', 'vimeo.com',
    'tumblr.com', 'bsky.app', 'mastodon.social', 'apps.apple.com', 'play.google.com', 'producthunt.com',
    'trustpilot.com', 'yelp.com', 'glassdoor.com', 'crunchbase.com', 'substack.com', 'patreon.com',
    'soundcloud.com', 'g2.com', 'capterra.com'];
  const LOGO_HOSTS = ['logo.clearbit.com', 'img.logo.dev', 'logo.dev', 'cdn.brandfetch.io', 'icon.horse',
    'icons.duckduckgo.com', 'favicone.com', 'logo.uplead.com'];

  // Other names designers use for a logo file or class: "brandco-wordmark", "/static/branding/...".
  const LOGO_SYNONYMS = new Set(['wordmark', 'wordmarks', 'brandmark', 'brandmarks', 'lockup', 'branding', 'brandlogo']);
  const UI_ICON_WORDS = new Set(['icon', 'octicon', 'chevron', 'arrow', 'caret', 'close', 'menu', 'search']);
  const SKIP_TEXT_IN = new Set(['script', 'style', 'noscript', 'textarea', 'template', 'title', 'option',
    'select', 'iframe', 'object', 'canvas']);

  let settings = Object.assign({}, LB_DEFAULTS);
  let active = false;
  let kwRegex = null;   // global, for finding matches
  let kwTest = null;    // non-global, for quick checks
  let logoNames = [];   // [{ key: normalized }] for "Only these brands"
  let styleEl = null;
  const shadowRoots = new Set();          // WeakRef<ShadowRoot>
  const seenShadow = new WeakSet();
  const splits = new WeakMap();           // original Text -> nodes we split off it (DOM order)
  const spanOrigin = new WeakMap();       // our <span> -> original Text it came from

  const observer = new MutationObserver(onMutations);
  const OBSERVE = {
    childList: true, subtree: true, characterData: true, attributes: true,
    attributeFilter: ['src', 'srcset', 'alt', 'title', 'aria-label', 'href', 'class']
  };

  // Hide the page for the few milliseconds it takes to read settings, so nothing
  // shows unblurred on first paint. Removing our own <style> fails open.
  const gate = document.createElement('style');
  gate.textContent = 'html{visibility:hidden !important}';
  (document.documentElement || document).appendChild(gate);
  const gateTimer = setTimeout(openGate, 1000);
  function openGate() { clearTimeout(gateTimer); gate.remove(); }

  // ---------- helpers ----------

  function tokens(s) {
    if (!s) return [];
    return String(s).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  }
  function hasLogoWord(toks) {
    return toks.some((t) => t.includes('logo') && !/logo(ut|n|ff)/.test(t));
  }
  function hasBrandClass(el) {
    const names = (el.getAttribute('class') || '').split(/\s+/);
    names.push(el.getAttribute('id') || '');
    return names.some((n) => n && BRAND_CLASS.test(n));
  }
  function anyIn(toks, set) { return toks.some((t) => set.has(t)); }

  function toUrl(raw) {
    if (!raw || /^\s*(data:|javascript:|#)/i.test(raw)) return null;
    try { return new URL(raw.trim().split(/\s+/)[0], document.baseURI); } catch (e) { return null; }
  }
  function pathOf(raw) {
    const u = toUrl(raw);
    if (!u) return '';
    try { return decodeURIComponent(u.pathname); } catch (e) { return u.pathname; }
  }
  function hostMatches(host, list) {
    host = String(host || '').toLowerCase();
    return list.some((d) => host === d || host.endsWith('.' + d));
  }
  function parentOf(el) {
    if (el.parentElement) return el.parentElement;
    const p = el.parentNode;
    return p && p.nodeType === 11 && p.host ? p.host : null; // cross shadow boundary
  }
  function sameSite(u) {
    const a = lbHostKey(u.hostname), b = lbHostKey(location.hostname);
    return a === b || a.endsWith('.' + b) || b.endsWith('.' + a);   // docs.github.com ~ github.com
  }
  function isRootPath(u) {
    return /^\/(index\.(html?|php|aspx?))?$/i.test(u.pathname) || /^\/[a-z]{2}([-_][a-z]{2,4})?\/?$/i.test(u.pathname);
  }
  function mediaUrls(el) {
    const ln = el.localName;
    const out = [];
    if (ln === 'img' || ln === 'input' || ln === 'embed') {
      out.push(el.getAttribute('src'), el.getAttribute('data-src'), el.getAttribute('srcset'));
      if (ln === 'img' && el.currentSrc) out.push(el.currentSrc);
    } else if (ln === 'object') {
      out.push(el.getAttribute('data'));
    } else if (ln === 'svg') {
      const use = el.querySelector('use');
      if (use) out.push(use.getAttribute('href') || use.getAttribute('xlink:href'));
    }
    const style = el.getAttribute('style');
    if (style) {
      const m = style.match(/url\(\s*['"]?([^'")]+)/i);
      if (m) out.push(m[1]);
    }
    return out.filter(Boolean);
  }
  function labelText(el) {
    const parts = [el.getAttribute('alt'), el.getAttribute('title'), el.getAttribute('aria-label')];
    if (el.localName === 'svg') {
      const t = el.querySelector('title');
      if (t) parts.push(t.textContent);
    }
    return parts.filter(Boolean).join(' ');
  }
  function ownTokens(el) {
    const urls = mediaUrls(el);
    const useRefs = urls.filter((u) => u.startsWith('#')).join(' ');
    return tokens([
      el.getAttribute('class'), el.getAttribute('id'), labelText(el), useRefs,
      urls.map(pathOf).join(' ')
    ].join(' '));
  }
  function containerTokens(el) {
    const tag = el.localName.includes('-') ? el.localName : '';
    // Skip ids generated from headings ("toc-Logo_design"), which only describe page content.
    const id = el.getAttribute('id') || '';
    const useId = id && !/^(toc|cite|ref|fn|mw)[-_]/i.test(id) && !/^h[1-6]$/.test(el.localName);
    return tokens([el.getAttribute('class'), useId ? id : '', el.getAttribute('aria-label'),
      el.getAttribute('title'), tag].join(' '));
  }
  function isMedia(el) {
    const ln = el.localName;
    return ln === 'img' || ln === 'svg' || ln === 'object' || ln === 'embed' ||
      (ln === 'input' && (el.getAttribute('type') || '').toLowerCase() === 'image') ||
      el.getAttribute('role') === 'img' ||
      /url\(/i.test(el.getAttribute('style') || '');
  }
  function closestLink(el) {
    let n = el;
    for (let i = 0; n && i < 6; i++, n = parentOf(n)) {
      if (n.localName === 'a' && n.hasAttribute('href')) return n;
    }
    return null;
  }
  function textLen(el) { return (el.textContent || '').trim().length; }

  // Small enough to be a logo lockup rather than a whole header/section.
  function isSmallContainer(el) {
    if (/^(html|body|head|header|nav|footer|main|section|article|aside|ul|ol|form|table|h[1-6]|p|button)$/.test(el.localName)) return false;
    if (textLen(el) > 40) return false;
    if (el.querySelectorAll('a, button, input, select, textarea, li').length > 1) return false;
    if (el.querySelectorAll('img, svg').length > 3) return false;
    return true;
  }
  function dims(el) {
    // Lazy loaders show a 1x1 placeholder first; ignore it and wait for the real image's load event.
    const real = el.localName === 'img' && el.naturalWidth > 2;
    const w = (real && el.naturalWidth) || parseFloat(el.getAttribute('width')) || 0;
    const h = (real && el.naturalHeight) || parseFloat(el.getAttribute('height')) || 0;
    return [w, h];
  }
  function isBig(el) { const [w, h] = dims(el); return w > 600 || h > 300; }      // photos, heroes
  function isLarge(el) { const [w, h] = dims(el); return w > 160 || h > 160; }    // bigger than an icon
  function isKnownSmall(el) { const [w, h] = dims(el); return w > 0 && h > 0 && w <= 160 && h <= 160; }
  function isTiny(el) {
    const w = parseFloat(el.getAttribute('width')), h = parseFloat(el.getAttribute('height'));
    return (w > 0 && w < 12) || (h > 0 && h < 10);
  }
  function sizeLooksLikeLogo(el) {
    if (el.localName !== 'img') return true;
    const w = el.naturalWidth || +el.getAttribute('width') || 0;
    const h = el.naturalHeight || +el.getAttribute('height') || 0;
    if (!w || !h) return true;                 // unknown yet; re-checked on load
    if (w > 800 || h > 300) return false;
    return h <= 64 || w / h >= 1.25 || /\.svg(\?|$)/i.test(el.currentSrc || el.getAttribute('src') || '');
  }

  // ---------- logo detection ----------

  // Returns why `el` looks like a logo ("" if it doesn't). The reason is stored in
  // data-lb-blur, so Inspect Element shows which rule fired.
  function logoReason(el) {
    const media = isMedia(el);
    const icon = !media && (el.localName === 'i' || el.localName === 'span') && textLen(el) <= 2;

    if (media || icon) {
      const own = ownTokens(el);
      const avatar = anyIn(own, AVATAR_WORDS);
      const big = isBig(el);
      const structural = tokens([el.getAttribute('class'), el.getAttribute('id'), mediaUrls(el).map(pathOf).join(' ')].join(' '));
      const label = tokens(labelText(el));
      // "logo" in a class or file name is decisive; in alt text only for logo-sized images
      // (a hero photo described as "...centered Apple logo" stays visible).
      if (hasLogoWord(structural) || (!big && hasLogoWord(label))) return 'logo-name';
      if (!big && !isLarge(el) && anyIn(structural, LOGO_SYNONYMS)) return 'logo-name';
      if (own.some((t) => t.startsWith('favicon'))) return 'favicon';
      // Brand names (fa-twitter, /icons/github.svg) only on icon-sized things, and in labels
      // only when the label is just the name ("GitHub").
      const classId = tokens([el.getAttribute('class'), el.getAttribute('id')].join(' '));
      const iconFile = mediaUrls(el).some((u) => /\.svg(\?|$)|\/(icons?|social|badges?|brands?)\//i.test(u));
      const brandFromFile = (iconFile || isKnownSmall(el)) && anyIn(tokens(mediaUrls(el).map(pathOf).join(' ')), BRAND_NAMES);
      if (!avatar && !big && !isLarge(el) && (anyIn(classId, BRAND_NAMES) || brandFromFile || (label.length <= 2 && anyIn(label, BRAND_NAMES)))) return 'brand-icon';
      if (media && mediaUrls(el).some((u) => { const x = toUrl(u); return x && hostMatches(x.hostname, LOGO_HOSTS); })) return 'logo-service';

      // Rules below use surroundings only; tiny glyphs (arrows, chevrons) are never logos.
      if (isTiny(el)) return '';

      // Inside a logo/brand wrapper: <a class="navbar-brand"><img></a>, <div class="logo"><svg>
      let p = parentOf(el);
      for (let i = 0; p && i < 4; i++, p = parentOf(p)) {
        if (hasLogoWord(containerTokens(p)) || hasBrandClass(p)) return 'in-logo-wrapper';
      }

      const link = closestLink(el);
      if (link) {
        const u = toUrl(link.getAttribute('href'));
        if (u) {
          if (media && lbHostKey(u.hostname) === lbHostKey(location.hostname) && isRootPath(u) && textLen(link) <= 40) return 'home-link';
          if (!avatar && !sameSite(u) && !isLarge(el) && hostMatches(u.hostname, SOCIAL_HOSTS)) return 'social-link';
          if (el.localName === 'img' && !sameSite(u) && isRootPath(u) && textLen(link) <= 30 && !avatar) return 'partner-link';
        }
      }

      // Logo walls: "Trusted by", "Our clients", "Partners"...
      if (media && !avatar && !anyIn(classId, UI_ICON_WORDS) && sizeLooksLikeLogo(el)) {
        let q = parentOf(el);
        for (let i = 0; q && i < 6; i++, q = parentOf(q)) {
          if (anyIn(containerTokens(q), WALL_WORDS)) return 'logo-wall';
        }
      }
      return '';
    }

    if ((hasLogoWord(containerTokens(el)) || hasBrandClass(el)) && isSmallContainer(el)) return 'logo-container';
    return '';
  }

  function mediaMatchesKeyword(el) {
    if (!kwTest || !isMedia(el)) return false;
    const names = [labelText(el)].concat(mediaUrls(el).map((u) => pathOf(u).split('/').pop().replace(/[-_.]+/g, ' ')));
    return names.some((s) => s && kwTest.test(s));
  }

  // ---------- "Only these brands" ----------

  // "Coca-Cola" -> "cocacola", so it matches coca_cola_logo.svg, cocacola.com, alt="Coca Cola".
  function norm(s) {
    return String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}]+/gu, '');
  }

  function buildLogoNames() {
    const seen = new Set();
    logoNames = (settings.logoNames || []).map((n) => ({ key: norm(n) }))
      .filter((n) => n.key.length >= 2 && !seen.has(n.key) && seen.add(n.key));
  }

  // Everything that can name the brand behind an element: alt/title/aria-label, file name,
  // class/id, the link's destination (nike.com), nearby wrappers, and short logo text.
  function nameHaystack(el) {
    const parts = [labelText(el), el.getAttribute('class'), el.getAttribute('id')];
    mediaUrls(el).forEach((u) => parts.push(pathOf(u)));
    if (!isMedia(el) && textLen(el) <= 40) parts.push(el.textContent);
    const link = closestLink(el);
    if (link) {
      const u = toUrl(link.getAttribute('href'));
      // A link to another site names its brand (nike.com). Links within this site and paths
      // (/news/stripe-and-openai, linkedin.com/company/acme) say nothing about the icon itself.
      if (u && !sameSite(u)) parts.push(u.hostname.replace(/^www\./, ''));
      parts.push(link.getAttribute('aria-label'), link.getAttribute('title'));
    }
    let p = parentOf(el);
    for (let i = 0; p && i < 3; i++, p = parentOf(p)) {
      parts.push(p.getAttribute('class'), p.getAttribute('id'), p.getAttribute('aria-label'), p.getAttribute('title'));
    }
    return norm(parts.filter(Boolean).join(' '));
  }

  function brandReason(el) {
    if (!logoNames.length || isTiny(el) || isBig(el)) return '';   // skip arrows and photos
    const hay = nameHaystack(el);
    const hit = logoNames.find((n) => hay.includes(n.key));
    if (!hit) return '';
    // Any image naming the brand counts; other elements must also look like a logo.
    // Reason is just "brand": the name itself never goes into the page, where DevTools could show it.
    return isMedia(el) || logoReason(el) ? 'brand' : '';
  }

  function evaluate(el) {
    if (el.nodeType !== 1 || el.ownerSVGElement) return;       // skip parts inside an <svg>
    const parent = el.parentElement;
    let reason = '';
    if (!(parent && parent.closest(`[${ATTR_BLUR}]`))) {
      const logo = !settings.blurLogos ? '' : settings.logoMode === 'list' ? brandReason(el) : logoReason(el);
      reason = logo || (settings.blurKeywords && mediaMatchesKeyword(el) ? 'keyword' : '');
    }
    if (reason) { if (el.getAttribute(ATTR_BLUR) !== reason) el.setAttribute(ATTR_BLUR, reason); }
    else if (el.hasAttribute(ATTR_BLUR)) el.removeAttribute(ATTR_BLUR);
  }

  function scanLogos(root) {
    if (!settings.blurLogos && !kwTest) return;
    if (root.nodeType === 1 && root.matches(CANDIDATES)) evaluate(root);
    if (root.querySelectorAll) root.querySelectorAll(CANDIDATES).forEach(evaluate);
  }

  // ---------- keyword text ----------

  function buildRegex() {
    kwRegex = kwTest = null;
    if (!settings.blurKeywords) return;
    const words = [...new Set((settings.keywords || []).map((k) => String(k).trim()).filter(Boolean))]
      .sort((a, b) => b.length - a.length)
      .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'));
    if (!words.length) return;
    let src = '(?:' + words.join('|') + ')';
    if (settings.wholeWord) src = '(?<![\\p{L}\\p{N}_])' + src + '(?![\\p{L}\\p{N}_])';
    const flags = 'u' + (settings.caseSensitive ? '' : 'i');
    kwRegex = new RegExp(src, 'g' + flags);
    kwTest = new RegExp(src, flags);
  }

  function textNodeOk(n) {
    const p = n.parentNode;
    if (!p) return false;
    if (p.nodeType === 11) return true;                           // directly in a shadow root
    if (p.nodeType !== 1) return false;
    if (p.namespaceURI !== 'http://www.w3.org/1999/xhtml') return false;   // <svg> text etc.
    if (SKIP_TEXT_IN.has(p.localName)) return false;
    if (p.closest(`[${ATTR_KW}], [contenteditable]:not([contenteditable="false" i])`)) return false;
    return document.designMode !== 'on';
  }

  function wrapText(node) {
    const text = node.data;
    const matches = [];
    kwRegex.lastIndex = 0;
    let m;
    while ((m = kwRegex.exec(text))) {
      if (!m[0].length) { kwRegex.lastIndex++; continue; }
      matches.push([m.index, m.index + m[0].length]);
    }
    if (!matches.length) return;
    // Split from the end so the original node stays in place holding the first piece.
    // Frameworks (React etc.) keep a reference to that node, so we never replace it.
    const created = splits.get(node) || [];
    const added = [];
    for (let i = matches.length - 1; i >= 0; i--) {
      const [s, e] = matches[i];
      const tail = e < node.length ? node.splitText(e) : null;
      const mid = node.splitText(s);
      const span = document.createElement('span');
      span.setAttribute(ATTR_KW, '');
      mid.parentNode.insertBefore(span, mid);
      span.appendChild(mid);
      spanOrigin.set(span, node);
      if (tail) added.unshift(span, tail); else added.unshift(span);
    }
    splits.set(node, added.concat(created));
  }

  function processText(node) {
    if (!kwRegex || !node.isConnected || !kwTest.test(node.data) || !textNodeOk(node)) return;
    wrapText(node);
  }

  function scanText(root) {
    if (!kwRegex) return;
    if (root.nodeType === 3) { processText(root); return; }
    const found = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (kwTest.test(n.data) && textNodeOk(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT)
    });
    while (walker.nextNode()) found.push(walker.currentNode);
    found.forEach(wrapText);
  }

  // Page changed the text of a node we split: drop our pieces, the node now holds the full new text.
  function dropSplit(orig) {
    const created = splits.get(orig);
    if (!created) return;
    created.forEach((n) => n.remove());
    splits.delete(orig);
  }

  // Put text back exactly as it was.
  function restoreText(root) {
    const origins = new Set();
    root.querySelectorAll(`span[${ATTR_KW}]`).forEach((span) => {
      const o = spanOrigin.get(span);
      if (o && splits.has(o)) origins.add(o);
      else span.replaceWith(...span.childNodes);
    });
    origins.forEach((orig) => {
      let text = orig.data;
      for (const n of splits.get(orig)) {
        if (n.parentNode) { text += n.textContent; n.remove(); }
      }
      orig.data = text;
      splits.delete(orig);
    });
  }

  // ---------- shadow DOM ----------

  function shadowOf(el) {
    if (el.shadowRoot) return el.shadowRoot;
    if (el.localName.includes('-') && chrome.dom && chrome.dom.openOrClosedShadowRoot) {
      try { return chrome.dom.openOrClosedShadowRoot(el) || null; } catch (e) { return null; }
    }
    return null;
  }

  function findShadowRoots(root) {
    const start = root.nodeType === 1 ? root : null;
    if (start) { const sr = shadowOf(start); if (sr) attachRoot(sr); }
    if (!root.querySelectorAll) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      const el = walker.currentNode;
      const sr = shadowOf(el);
      if (sr) attachRoot(sr);
    }
  }

  function attachRoot(sr) {
    if (seenShadow.has(sr)) return;
    seenShadow.add(sr);
    shadowRoots.add(new WeakRef(sr));
    const s = document.createElement('style');
    s.setAttribute('data-lb-style', '');
    s.textContent = RULES;
    sr.appendChild(s);
    if (sr.host) evaluate(sr.host);
    scan(sr);
    observer.observe(sr, OBSERVE);
  }

  function liveRoots() {
    const out = [document];
    for (const ref of shadowRoots) {
      const sr = ref.deref();
      if (sr && sr.host && sr.host.isConnected) out.push(sr); else shadowRoots.delete(ref);
    }
    return out;
  }

  // ---------- lifecycle ----------

  function scan(root) {
    scanLogos(root);
    scanText(root);
    findShadowRoots(root);
  }

  function onMutations(records) {
    if (!chrome.runtime || !chrome.runtime.id) {   // extension was updated/removed: this copy is orphaned
      observer.disconnect(); active = false; return;
    }
    if (!active) return;
    if (styleEl && !styleEl.isConnected) (document.head || document.documentElement).appendChild(styleEl);
    for (const r of records) {
      if (r.type === 'childList') {
        r.removedNodes.forEach((n) => { if (n.nodeType === 3 && splits.has(n)) dropSplit(n); });
        r.addedNodes.forEach((n) => {
          if (!n.isConnected) return;
          if (n.nodeType === 1) scan(n);
          else if (n.nodeType === 3) processText(n);
        });
      } else if (r.type === 'characterData') {
        if (splits.has(r.target)) dropSplit(r.target);
        processText(r.target);
      } else if (r.type === 'attributes') {
        if (r.target.isConnected && r.target.matches(CANDIDATES)) evaluate(r.target);
      }
    }
    maskTitle();
    observer.takeRecords(); // discard the records our own edits just produced
  }

  // ---------- tab title ----------
  // A tab title can't be blurred, so keywords in it become "•••". Only the top frame owns the title.
  let titleOriginal = null;   // the page's own title
  let titleMasked = null;     // what we set, so our own write isn't mistaken for a page update

  function maskTitle() {
    if (window !== window.top) return;
    const cur = document.title;
    if (titleMasked !== null && cur === titleMasked) return;
    titleOriginal = cur;
    titleMasked = null;
    if (!active || !kwRegex || !cur) return;
    kwRegex.lastIndex = 0;
    const masked = cur.replace(kwRegex, '•••');
    if (masked !== cur) { titleMasked = masked; document.title = masked; }
  }

  function restoreTitle() {
    if (titleMasked !== null && document.title === titleMasked) document.title = titleOriginal;
    titleMasked = null;
  }

  function onImageLoad(e) {
    if (active && e.target && e.target.localName === 'img') evaluate(e.target);
  }
  function onShadowAttached(e) {
    if (!active) return;
    const host = e.composedPath()[0];
    if (host && host.nodeType === 1) { const sr = shadowOf(host); if (sr) attachRoot(sr); }
  }

  function topHost() {
    const anc = location.ancestorOrigins;
    if (anc && anc.length) {
      try { return new URL(anc[anc.length - 1]).hostname; } catch (e) { /* fall through */ }
    }
    return location.hostname;
  }
  function siteDisabled() {
    const host = lbHostKey(topHost());
    return (settings.disabledSites || []).some((d) => host === d || host.endsWith('.' + d));
  }

  function teardown() {
    restoreTitle();
    observer.disconnect();
    document.removeEventListener('load', onImageLoad, true);
    for (const root of liveRoots()) {
      root.querySelectorAll(`[${ATTR_BLUR}]`).forEach((el) => el.removeAttribute(ATTR_BLUR));
      restoreText(root);
    }
  }

  function apply() {
    teardown();
    buildRegex();
    buildLogoNames();
    const logosOn = settings.blurLogos && (settings.logoMode !== 'list' || logoNames.length > 0);
    active = settings.enabled && !siteDisabled() && (logosOn || !!kwRegex);
    if (!active) return;

    if (!styleEl) { styleEl = document.createElement('style'); styleEl.setAttribute('data-lb-style', ''); }
    const px = Math.max(1, Math.min(40, Number(settings.strength) || 8));
    styleEl.textContent = `:root{--lb-blur:${px}px !important}` + RULES;
    if (!styleEl.isConnected) (document.head || document.documentElement).appendChild(styleEl);

    for (const root of liveRoots()) scan(root);
    maskTitle();
    observer.observe(document, OBSERVE);
    for (const root of liveRoots()) if (root !== document) observer.observe(root, OBSERVE);
    document.addEventListener('load', onImageLoad, true);
  }

  function sweepShadows() {
    if (!active) return;
    // At document_start there is no <head> yet; move our sheet after the page's own stylesheets.
    if (styleEl && document.head && styleEl.parentNode !== document.head) document.head.appendChild(styleEl);
    liveRoots().forEach(findShadowRoots);
  }

  function stats() {
    let logos = 0, keywords = 0;
    for (const root of liveRoots()) {
      logos += root.querySelectorAll(`[${ATTR_BLUR}]`).length;
      keywords += root.querySelectorAll(`span[${ATTR_KW}]`).length;
    }
    return { active, logos, keywords };
  }

  // ---------- wiring ----------

  document.addEventListener('logoblur:shadow', onShadowAttached, true);
  document.addEventListener('DOMContentLoaded', sweepShadows);
  window.addEventListener('load', sweepShadows);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.settings) {
      settings = Object.assign({}, LB_DEFAULTS, changes.settings.newValue || {});
      apply();
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'lb:stats' && window === window.top) { sendResponse(stats()); }
  });

  lbLoadSettings().then((s) => {
    settings = s;
    try { apply(); } finally { openGate(); }
  }, openGate);
})();

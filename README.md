# Logo & Keyword Blur

Chrome extension that blurs logos and the keywords you choose on every site. Built for screen recordings, demos and screenshots.

## Install (2 minutes)

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this folder.
4. Pin the extension (puzzle icon → pin), click it, and add your keywords.

Tabs that were already open start blurring right away; no reload needed. After editing any file here, click the reload arrow on the extension's card in `chrome://extensions`.

## Using it

- **Only these brands**: under *Blur logos*, switch from **All logos** to **Only these brands** and add names (Nike, Coca-Cola). Only logos whose alt text, file name, label, or link (nike.com) matches a name are blurred. Spaces, dashes and case don't matter, so "Coca-Cola" matches `coca_cola_logo.svg`. Inline SVG logos with no name or link can't be identified this way; use **All logos** for those.
- **Hidden names for demos**: saved brand names and keywords show as `•••••`. Click the eye icon next to **Brands** or **Keywords** to see that list; both are hidden again every time the popup opens. What you type in the box stays visible. Names never go into the web page itself: a blurred brand logo is tagged just `brand`, so DevTools doesn't show which one.
- **Popup**: master switch, logos on/off, keywords on/off, blur strength, keyword list, whole-word and match-case options. It also shows how many items are blurred on the current page.
- **Keywords**: type one and press Enter, or click **Add many…** and enter one per line (`Cmd+Enter` adds them all; duplicates are skipped). Pasting a comma- or line-separated list into the single box works too. Phrases work ("Acme Corp"). Images whose alt text or file name contains a keyword are blurred too.
- **Tab titles**: a title can't be blurred, so keywords in it become `•••` (e.g. "Globex – Dashboard" → "••• – Dashboard"). The real title comes back when you turn blurring off. Pages visited while it's on are saved in your Chrome history with the masked title.
- **Shortcut**: `Alt+Shift+B` turns blurring on or off on every tab. A grey **OFF** badge shows when it's off. Change the key at `chrome://extensions/shortcuts`.

## How logo detection works

There's no list of known logos; the content script ([src/content.js](src/content.js)) checks each image, SVG and icon against these rules. The rule that fired is written into the element's `data-lb-blur` attribute, so **Inspect Element** tells you why something was blurred.

| Reason | Catches |
|---|---|
| `logo-name` | "logo" in the class, id, file name, or (for logo-sized images) the alt text |
| `in-logo-wrapper` / `logo-container` | inside `.logo`, `.navbar-brand`, `.site-title`, `.site-branding` |
| `home-link` | an image linking to the site's home page (the classic header logo) |
| `social-link` / `brand-icon` | icons linking to Facebook, LinkedIn, GitHub… and `fa-twitter`-style brand icons |
| `logo-wall` | images in "clients", "partners", "trusted by", "customers" sections |
| `favicon` / `logo-service` | favicons and logo APIs (Clearbit, logo.dev, Brandfetch) |
| `keyword` | image alt text or file name contains one of your keywords |
| `brand` | "Only these brands" mode: the image or logo matches one of your brand names |

Keyword text is wrapped in `<span data-lb-kw>`. Turning blurring off restores the page's text exactly as it was.

## What it won't catch

- Logos drawn into a larger image (a photo with a logo on a shirt), or set as a CSS background through a stylesheet with no "logo" in the class name.
- Keywords inside text boxes, editors (`contenteditable`), or the address bar. Chrome doesn't let extensions change the address bar: record only the page area, or use full screen with **View → Always Show Toolbar in Full Screen** turned off.
- A phrase split across formatting, e.g. `Acme <b>Corp</b>` won't match "Acme Corp" (single words still match).
- Chrome's own pages (`chrome://`, the Web Store) — extensions aren't allowed there.

Text blur hides words well at the default 8px, but blur leaks word length. For sensitive names in recordings, keep strength at 8px or higher.

## Testing

`test/run.mjs` loads the extension into a headless Chrome for Testing and checks [test/fixture.html](test/fixture.html): logos blurred, non-logos left alone, keywords in normal text, late-loaded content, shadow DOM and framework-updated text, and a clean undo when switched off.

```bash
node test/run.mjs
```

`test/late-install.mjs` opens a page first, then installs the extension into the running browser, and checks the page starts blurring without a reload:

```bash
node test/late-install.mjs
```

Pass URLs to screenshot live sites into `test/out/` (set `KEYWORDS` to try keywords):

```bash
KEYWORDS="Stripe,Google" node test/run.mjs https://stripe.com https://github.com
```

Branded Google Chrome no longer accepts `--load-extension`, so the script looks for Playwright's Chrome for Testing in `~/Library/Caches/ms-playwright`, or uses the `CHROME` env var.

## Files

```
manifest.json        MV3 manifest
src/content.js       detection, keyword wrapping, MutationObserver, undo
src/shadow-hook.js   tells the content script when a page adds a shadow root
src/settings.js      settings defaults + storage helpers
src/background.js    keyboard shortcut and OFF badge
popup/               the toolbar popup
icons/               toolbar and store icons
test/                fixture page and headless test runner
```

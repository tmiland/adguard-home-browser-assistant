# AdGuard Home Browser Assistant

An unofficial Firefox companion for **AdGuard Home**: see the filtering state
of the current tab, block or unblock it (for everyone or just this client),
pause protection, view AGH stats, and get an automatic HTTPS block page — using
your existing logged-in AGH session.

It does not filter traffic itself. AGH does the DNS filtering; this extension is
the browser-side control surface.

## Features

### Toolbar popup

- Current tab status from AGH `check_host` (Blocked / Allowed), with the applied
  rule/reason and the client.
- **Block** or **Unblock** the current hostname for all devices:
  `||host^$important` / `@@||host^$important`.
- **Block / Unblock for this client only**:
  `||host^$client='<client>'` / `@@||host^$client='<client>'`.
  The client comes from the latest query-log entry for the host; set one in
  Settings if auto-detection is wrong.
- **Protection**: on/paused, pause for 30s / 1m / 5m / 15m, resume. This calls
  AGH's `/control/protection` with a duration in milliseconds.
- **Stats**: total queries and blocked count from `/control/stats`.
- Links to the AGH query log, AGH home, and Settings.

### Automatic HTTPS block page

Top-level navigation errors are caught with `webNavigation.onErrorOccurred`.
The extension confirms with AGH `check_host` (and the latest query-log entry for
CNAME/IP/cached cases), then replaces the browser error with `blocked.html`.
No CA, no TLS interception, no VIP/NAT. The block page has Unblock, Unblock for
this client only, and **Temporarily unblock** (30 seconds / 1 / 5 / 15 minutes),
and polls through AGH's asynchronous ~6 s filter rebuild. The temporary rule is
removed by the background after the chosen duration; if the browser closes first,
cleanup resumes on the next extension start.

### Element hiding

AdGuard Home understands cosmetic rules such as `example.com##.ad-banner` and
stores them in its user rules, but DNS filtering cannot inject CSS. The
assistant reads those rules back and applies the matching CSS in Firefox, so
the rule is visible and editable in AGH while the browser does the hiding.

- Toolbar **Pick element to hide** (or right-click → **Hide element with
  AdGuard Home Assistant**) starts a picker: hover to highlight, click the
  element, edit the generated selector if needed, then **Hide**.
- Picked rules are saved to AGH user rules by default (`example.com##.ad-banner`).
  If the AGH session is unavailable, the rule is saved locally instead.
- Global CSS-injection rules (`example.com#$#body { ... }`) and exceptions
  (`#@#`, `#@$#`) work too. Extended selectors that Firefox's CSS engine
  supports (for example `:has()`) are applied; unsupported ones are skipped.
- Settings has local rules for this browser and a switch to stop saving picked
  rules to AGH.

AGH user rules are read through the same logged-in session; local rules are
stored with `browser.storage.local`. Scriptlet/JS rules (`#%#`, `#@%#`) are
deliberately not executed.

### Query-log buttons

The original query-log **Unblock** buttons remain: blocked rows get a green
button and there is a floating unblock-by-domain widget. It adds the allowlist
rule, clears AGH's cache, and polls `check_host` until the rebuild finishes.

## Existing AGH session

No password is stored. The add-on reuses the `agh_session` cookie:

- a direct extension-origin request is tried first;
- if SameSite/CORS prevents that, it uses a same-origin fetch inside an AGH UI
  tab (`src/api-bridge.js`), opening an inactive tab if necessary.

The default AGH URL is **`https://adguard.home.tmiland.com`** — the actual
session host. Set it in Settings if your AGH UI lives elsewhere.

## Install (temporary)

1. Make sure the AGH UI is reachable and logged in:
   `https://adguard.home.tmiland.com`.
2. Firefox → `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…**
3. Select `manifest.json` from this repo.
4. Open the toolbar icon. The popup shows the current site, protection,
   element-hiding state and stats. Use Settings to set the client or disable
   the automatic block page; use **Pick element to hide** or the page context
   menu for cosmetic rules.

Permanent installation: self-hosted signing or AMO (`web-ext build` +
`web-ext sign`).

## Rule syntax

AGH uses Adblock-style DNS rules
([syntax reference](https://adguard-dns.io/kb/general/dns-filtering-syntax/)).
The assistant uses:

- `||example.com^` — the domain and all subdomains.
- `@@||example.com^$important` — an allowlist exception for all clients.
- `@@||example.com^$client='192.168.1.2'` — the same exception for one client.
- `||example.com^$important` — a block rule for the site.
- `example.com##.ad-banner` — hide matching elements on the site and subdomains.
- `example.com#@#.ad-banner` — cancel that hide rule for the site.
- `example.com#$#body { overflow: auto !important; }` — inject a style rule.
- `example.com#?#.ad:has(> .sponsor)` — extended selector, if Firefox supports it.

When a site is blocked by a **parent-domain** rule (e.g. `||memfault.com^` blocks
`chunks.memfault.com`), the assistant unblocks the **rule’s domain**
(`@@||memfault.com^$important`), not just the current hostname, so every
subdomain of the site works.

## Limitations

- Firefox only (Manifest v2). Per-browser, not network-wide; phones/TVs/IoT do
  not get the block page or element hiding.
- Automatic pages only for top-level navigations, not blocked subresources.
- The AGH session must be valid; if it expires, open AGH, log in and retry.
- The browser can hold a `0.0.0.0` answer for up to `blocked_response_ttl`
  (10 s); if a redirect still fails, wait and reload.
- Temporary unblocks are timer-based, not AGH-native. The rule is removed by the
  extension after the duration; if the browser is closed, cleanup runs when it
  starts again. If the AGH session expires at that moment, removal is retried.
- Element hiding applies only in Firefox with this assistant. AGH still stores
  the cosmetic rules, but its DNS engine does not inject CSS into pages.
- Cosmetic rules are read from AGH **user rules** and the local rules box; rules
  inside subscribed filter lists are not imported. Scriptlet/JS rules are not
  executed, and unsupported extended selectors are skipped.
- On pages with a strict Content-Security-Policy, the assistant injects CSS at
  user origin (`tabs.insertCSS`) so page CSP does not block the rules. The
  picker overlay uses a separate shadow-root UI.

## Files

- `src/background.js` — navigation errors, AGH API, block/unblock/protection/stats, cosmetic cache.
- `src/cosmetic-rules.js` — Adblock cosmetic-rule parser/matcher (also used by tests).
- `src/cosmetic.js` — element hiding + picker content script.
- `src/api-bridge.js` — same-origin AGH API bridge in an AGH tab.
- `src/content.js` — query-log buttons/widget.
- `popup.html|css|js` — Browser Assistant toolbar popup.
- `blocked.html|css|js` — automatic block page.
- `options.html|css|js` — settings.
- `test/cosmetic-rules.test.js` — parser/matcher tests (`node --test test/`).

## License

MIT — see [LICENSE](LICENSE). This is an unofficial project, not affiliated with
AdGuard.

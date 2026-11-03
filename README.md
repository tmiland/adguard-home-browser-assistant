# AdGuard Home Browser Assistant

An unofficial Firefox companion for **AdGuard Home (AGH)**: see the filtering
state of the current tab, block or unblock the current site (for everyone or
just this client), pause protection, view AGH stats, and get an automatic HTTPS
block page — using your existing logged-in AGH session.

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
- **Temporary unblocks**: active temporary rules, each with a live countdown
  and a **Cancel** button.
- Links to the AGH query log, AGH home, and Settings.

### Automatic HTTPS block page

Top-level navigation errors are caught with `webNavigation.onErrorOccurred`.
The extension confirms with AGH `check_host` (and the latest query-log entry for
CNAME/IP/cached cases), then replaces the browser error with `blocked.html`.
No CA, no TLS interception, no VIP/NAT. The block page offers **Unblock**,
**Unblock for this client only**, and **Temporarily unblock** (30 seconds, 1
minute, 5 minutes, or 15 minutes). It polls through AGH's asynchronous ~6 s
filter rebuild. The temporary rule is removed by the background after the
chosen duration; if the browser closes first, cleanup resumes on the next
extension start.

### Element hiding

AdGuard Home accepts cosmetic rules such as `example.com##.ad-banner` and
stores them in its user rules, but DNS filtering cannot inject CSS. The
assistant reads those rules back and applies the matching CSS in Firefox, so
the rule is visible and editable in AGH while the browser does the hiding.

- Toolbar **Pick element to hide** (or right-click → **Hide element with
  AdGuard Home Assistant**) starts a picker: hover to highlight, click the
  element, edit the generated selector if needed, then **Hide**. It hides only
  the selected element by default; tick **Hide all matching elements** to use a
  broader selector.
- Picked rules are saved to AGH user rules by default (`example.com##.ad-banner`).
  If the AGH session is unavailable, the rule is saved locally instead. Rules
  saved to AGH appear under **Rules from AdGuard Home** in Settings, not in the
  local rules box.
- Settings lists AGH cosmetic rules with **Remove** buttons and **Refresh**;
  use Refresh after editing rules directly in the AGH UI. Removing a rule
  through the assistant also refreshes open tabs.
- Global CSS-injection rules (`example.com#$#body { ... }`) and exceptions
  (`#@#`, `#@$#`) also work. Native CSS selectors (including `:has()`) are
  applied directly. A small extended-CSS engine also supports `:remove()`,
  `:style()`, `:has-text()`, `:upward()`, `:matches-css()` and
  `:not(:has-text(...))`; other extended selectors are skipped.
- Settings holds local rules for this browser and a switch to stop saving
  picked rules to AGH.

AGH user rules are read through the same logged-in session; local rules are
stored with `browser.storage.local`. Scriptlet/JS rules (`#%#`, `#@%#`) are
deliberately not executed.

### Query-log buttons

The query-log **Unblock** buttons are still available: each blocked row gets an
**Unblock** button, and there is a floating **Quick unblock** widget. It is branded
**AdGuard Home Browser Assistant** and can be collapsed (the state is
remembered). It accepts a URL or domain, normalizes it, adds the allowlist rule,
clears AGH's cache, and polls `check_host` until the rebuild finishes.

## Existing AGH session

No password is stored. The add-on reuses the `agh_session` cookie:

- a direct extension-origin request is tried first;
- if SameSite/CORS prevents that, it uses a same-origin fetch inside an AGH UI
  tab (`src/api-bridge.js`), opening an inactive tab if necessary.

There is no universal AGH URL. Set yours in **Settings**; the examples use
`https://adguard.example.com` or `http://192.168.1.1:3000`.

## Install (temporary)

1. Make sure your AGH UI is reachable and logged in (for example
   `https://adguard.example.com`).
2. Firefox → `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…**
3. Select `manifest.json` from this repo.
4. Open **Settings** and enter your AGH URL.
5. Open the toolbar icon. The popup shows the current site, protection,
   element-hiding state and stats. Use Settings to set the client or disable
   the automatic block page; use **Pick element to hide** or the page context
   menu for cosmetic rules.

For permanent installation, sign it yourself or publish through AMO
(`web-ext build` and `web-ext sign`).

## Rule syntax

AGH uses Adblock-style rules
([syntax reference](https://adguard-dns.io/kb/general/dns-filtering-syntax/)).
The assistant uses:

- `||example.com^` — the domain and all subdomains.
- `@@||example.com^$important` — an allowlist exception for all clients.
- `@@||example.com^$client='192.168.1.2'` — the same exception for one client.
- `||example.com^$important` — a block rule for the site.
- `example.com##.ad-banner` — hide matching elements for the site and its
  subdomains.
- `example.com#@#.ad-banner` — cancel that hide rule for the site.
- `example.com#$#body { overflow: auto !important; }` — inject a style rule.
- `example.com##.ad:has-text(/sponsor/):remove()` — extended text match.
- `example.com##.ad:upward(.feed)` — hide the matching ancestor element.
- `example.com##.ad:style(border: 1px solid red !important)` — extended style.
- `example.com##.ad:matches-css(display: none):remove()` — computed-style match.

When a site is blocked by a **parent-domain** rule (e.g. `||memfault.com^` blocks
`chunks.memfault.com`), the assistant unblocks the **rule’s domain**
(`@@||memfault.com^$important`), not just the current hostname, so every
subdomain of that domain works.

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
  executed. The extended-CSS engine covers the common selectors above, but not
  every AdGuard extended selector (for example `:matches-css-before` is skipped).
- On pages with a strict Content-Security-Policy, the assistant injects CSS at
  user origin (`tabs.insertCSS`) so page CSP does not block the rules. The
  picker overlay uses a separate shadow-root UI.

## Files

- `src/background.js` — navigation errors, AGH API,
  block/unblock/protection/stats, cosmetic cache.
- `src/rule-utils.js` — pure allow/block rule builder and duration labels (tested).
- `src/cosmetic-rules.js` — Adblock cosmetic-rule parser/matcher, including
  extended selectors.
- `src/cosmetic.js` — element hiding, extended-CSS runtime, picker content script.
- `src/api-bridge.js` — same-origin AGH API bridge in an AGH tab.
- `src/content.js` — query-log buttons and Quick unblock widget.
- `popup.html|css|js` — Browser Assistant toolbar popup.
- `blocked.html|css|js` — automatic block page.
- `options.html|css|js` — settings.
- `test/cosmetic-rules.test.js` — cosmetic parser/matcher tests.
- `test/rule-utils.test.js` — allow/block rule and duration tests.
- Run all tests with `node --test test/`.

## License

MIT — see [LICENSE](LICENSE). This is an unofficial project, not affiliated with
AdGuard.

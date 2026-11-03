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
No CA, no TLS interception, no VIP/NAT. The block page has the same two Unblock
options and polls through AGH's asynchronous ~6 s filter rebuild.

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
4. Open the toolbar icon. The popup shows the current site, protection and
   stats. Use Settings to set the client or disable the automatic block page.

Permanent installation: self-hosted signing or AMO (`web-ext build` +
`web-ext sign`).

## Limitations

- Firefox only (Manifest v2). Per-browser, not network-wide; phones/TVs/IoT do
  not get the block page.
- Automatic pages only for top-level navigations, not blocked subresources.
- The AGH session must be valid; if it expires, open AGH, log in and retry.
- The browser can hold a `0.0.0.0` answer for up to `blocked_response_ttl`
  (10 s); if a redirect still fails, wait and reload.
- AGH element blocking/reporting (as in the AdGuard desktop Browser Assistant)
  do not apply at DNS level and are not implemented.

## Files

- `src/background.js` — navigation errors, AGH API, block/unblock/protection/stats.
- `src/api-bridge.js` — same-origin AGH API bridge in an AGH tab.
- `src/content.js` — query-log buttons/widget.
- `popup.html|css|js` — Browser Assistant toolbar popup.
- `blocked.html|css|js` — automatic block page.
- `options.html|css|js` — settings.

## License

MIT — see [LICENSE](LICENSE). This is an unofficial project, not affiliated with
AdGuard.

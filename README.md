# AGQuery Unblock

Firefox add-on for **AdGuard Home** that gives you an Unblock workflow in two
places:

1. **Automatic HTTPS block page** — when an HTTPS navigation fails because AGH
   filtered the domain, the add-on catches the error, confirms the block with
   the AGH API, and replaces the browser error with its own block page.
2. **Query-log Unblock** — the existing green **Unblock** buttons on blocked
   rows in the AGH web UI.

No local CA, no TLS interception, no block-page server. The automatic page works
because it reacts inside the browser after the failed request, then uses your
**existing logged-in AGH session**.

## Automatic block page

When a top-level navigation fails:

1. `webNavigation.onErrorOccurred` fires for the main frame.
2. The add-on asks AGH `check_host` whether the hostname is filtered; if not,
   it falls back to the query log (covers CNAME/IP and cached-answer cases).
3. If blocked, the tab is replaced with `blocked.html`, showing the blocked URL,
   client, matched rule and reason.
4. **Unblock** adds `@@||host^$important` for all clients.
   **Unblock for this client only** adds `@@||host^$client='<client>'`.
5. It polls `check_host` until AGH's asynchronous filter rebuild finishes, then
   redirects back to the original URL.

The block page mirrors the query-log buttons: all clients, or only the client
shown (auto-detected from the latest query-log entry for the host). If no client
can be detected, set one in the extension options.

## Existing AGH session

Credentials are not stored. API calls reuse the browser's `agh_session` cookie:

- first via a direct extension-origin request (if the browser sends the cookie);
- otherwise via a same-origin fetch inside an AGH UI tab. If no logged-in AGH tab
  is open, the add-on opens an inactive one and keeps it for later operations.

If the session expired, the block page offers a link to AGH; log in and retry.

## Options

Open the add-on settings (toolbar button or Add-ons Manager):

- **AdGuard Home URL** — default `http://192.168.1.1:8088`.
- **This client** — optional client IP/name for “Unblock for this client only”.
  Leave empty to auto-detect from the query log.
- **Show the block page automatically** — on by default.
- **Test AGH session** — verifies the existing session through the same API path.

## Limitations

- Firefox only (Manifest v2). It works only in browsers with the add-on; phones,
  TVs and other clients still get the DNS/connection error.
- Only top-level navigations, not blocked subresources.
- It must be able to reach the AGH API; if the AGH session expired, it shows a
  login link instead of a block page.
- The AGH filter rebuild is still ~6 s; the page polls through it.
- The browser's own DNS cache can hold the old `0.0.0.0` for up to
  `blocked_response_ttl` (10 s). If the redirect still fails, wait a few seconds
  and reload.

## Query-log buttons

`src/content.js` injects Unblock buttons into blocked query-log rows and a
floating widget for unblocking by domain. It mirrors the AGH UI's
`@@||domain^$important` rule, clears the AGH cache, and now polls `check_host`
through the asynchronous rebuild instead of checking once.

## Install (temporary)

1. Ensure the AGH UI is reachable and logged in:
   `http://192.168.1.1:8088` (or `https://192.168.1.1:1443`).
2. Firefox → `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…**
3. Select `manifest.json`.
4. Open the add-on settings and set the AGH URL/client if needed.
5. Visit a blocked HTTPS site. The add-on block page should replace the browser
   error.

Permanent installation: self-hosted signing or AMO (`web-ext build` +
`web-ext sign`).

## Files

- `src/background.js` — navigation-error detection, AGH API, unblock logic.
- `src/api-bridge.js` — same-origin AGH API bridge in an AGH tab.
- `src/content.js` — query-log buttons/widget.
- `blocked.html|css|js` — automatic block page.
- `options.html|css|js` — settings.

## License

MIT — see [LICENSE](LICENSE).

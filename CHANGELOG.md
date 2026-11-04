# Changelog

## 1.2.0 — 2026-11-04

- **Removed the AGH-page Unblock UI**: the per-row buttons in the query log and
  the floating Quick unblock widget are gone. Unblocking stays in the toolbar
  popup and the automatic block page; only the same-origin API bridge is
  injected into the AGH UI. This also stops the row button from covering AGH's
  `⋮` row menu.
- **Fixed** the popup's Query log link to use AGH's `/#logs` route.

## 1.1.0 — 2026-11-04

- **Blocklist catalog page** linked from the popup and Settings: browse 7
  curated packs and 92 curated lists from
  `tmiland/dns-blocklist-catalog`, search all lists, and see which URLs are
  already subscribed in AdGuard Home.
- Import packs or individual lists via `/control/filtering/add_url`, then one
  `/control/filtering/refresh`; per-list failures and session expiry are
  reported.
- The catalog is cached for five minutes, with a forced refresh and a
  stale-cache fallback.
- Added catalog validation/selection helpers and tests.

## 1.0.1 — 2026-11-04

- **Undo** the last block/unblock from the toolbar popup for 60 seconds. The
  previous AdGuard Home user-rule set is restored, including a temporary-unblock
  timer that the action cancelled. Undo is refused if the rules changed
  elsewhere in the meantime.
- **Filter** the AdGuard Home cosmetic-rules list in Settings.
- Added GitHub Actions CI: unit tests, syntax checks, `web-ext lint`, and a
  build on every push and pull request.
- Added unit tests for undo planning and rule filtering.

## 1.0.0 — 2026-11-03

- First public release: current-site block/unblock (global or per client),
  temporary unblocks, protection pause, stats, automatic HTTPS block page,
  element hiding with a picker, AGH query-log buttons, and the Quick unblock
  widget.
- Submitted to addons.mozilla.org (listed).

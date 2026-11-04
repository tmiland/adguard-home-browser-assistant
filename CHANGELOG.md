# Changelog

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

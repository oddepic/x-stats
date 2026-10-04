# x-stats

## Summary

Local-first analytics and cleanup for X, as a Chromium extension. It tracks impressions, engagement, and followers per post, and trims non-followbacks at a safe automatic pace. Everything stays in your browser.

## Install

Host: Brave, Chrome, Edge, any Chromium with MV3. Minimum version 116.

```sh
git clone https://github.com/oddepic/x-stats.git
cd x-stats
npm test
```

## Usage

```sh
npm run build
```

1. Open `brave://extensions`, enable Developer mode, load unpacked, pick `src/`.
2. Open your x.com profile, click the x-stats icon, Sync this page.
3. Scroll the profile to load older posts, Sync again to backfill.
4. Open the Cleanup module, Scan following, tick accounts, hit the unfollow button.

## Options

Range: 7 days, 28 days, 90 days, All time. Scope: Personal shows the current page handle, All shows everything tracked. Pace: starts at 40 unfollows a day, rises to 100 on clean days, pauses a full day on any X warning.

## How it works

1. The content script reads visible counts and profile headers from x.com pages.
2. The service worker stores posts, snapshots, and relationships in local browser storage.
3. The popup shows the current page: stats for that handle, cleanup for that following list.
4. The dashboard adds charts, top posts, CSV export, analytics CSV import, and the action log.
5. Cleanup runs run in the X tab at jittered 25 to 45 second gaps with session breaks.

## Stack

| Piece | Choice |
|---|---|
| Runtime | Vanilla JS, no dependencies |
| Extension | Manifest V3, minimum Chrome 116 |
| Storage | chrome.storage.local, no server |
| Tests | node:test, `npm test` |

## Structure

```
src/
  background/  service worker, storage, pace gates
  content/     x.com scrapers and safe runners
  popup/       main UI, Analytics and Cleanup modules
  dashboard/   full page: charts, import, log
  lib/         pure stat, page, and pacing helpers
test/          unit tests for lib
scripts/       pack script, outputs dist/x-stats.zip
```

## Security

Page content from x.com is untrusted input: counts are parsed as numbers, text is truncated and HTML-escaped before display. Automation acts only on accounts you tick, behind a confirm, a daily pace, and an abort on any X warning. Do not raise the pace constants to chase speed.

## Troubleshooting

Sync finds 0 posts: scroll so tweets render, then Sync again. Followers show a dash: sync from the profile page top so the header counts render. Scan opens the wrong account: open that profile first, then scan. Stats are empty after switching accounts: set the owner with the pencil, Reset everything, resync.

## License

MIT, see LICENSE.

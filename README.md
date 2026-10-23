# OnTilt

Peer-to-peer Texas Hold'em for friends. A static site, no server.

**Play:** https://walstan.me/OnTilt/

## Project layout

```
public/              # everything served by GitHub Pages
  index.html         # page shell
  css/
    base.css         # tokens, resets, app frame
    table.css        # top bar, seats, cards
    controls.css     # action buttons, my-hand row, emotes
    lobby.css        # lobby / table setup
    overlays.css     # sheets and toast
    desktop.css      # wide-screen layout: widened open table + action dock, hover states
    features.css     # brand, lobby extras, stack bars, sheets
    motion.css       # animations and transitions
  js/
    config.js        # app ID, relays, TURN servers, shot clock
    sound.js         # synthesized sounds + vibration (no audio files)
    qr.js            # QR codes for invites (bundled qrcode-generator in vendor/)
    lan.js           # offline Wi-Fi connections: WebRTC with the handshake carried in QR codes
    scan.js          # camera QR scanner (BarcodeDetector, or bundled jsQR)
    morph.js         # tiny DOM patcher so re-renders keep elements (and their transitions)
    engine.js        # Hold'em rules engine (pure logic, no DOM)
    ui-helpers.js    # formatting, icons, card markup, toast, storage
    app.js           # networking, host loop, rendering, input
  assets/favicon.svg
  sw.js              # service worker: caches the app so it opens without internet
  manifest.webmanifest
.github/workflows/deploy.yml   # tests the engine, then deploys public/ to Pages on every push to main
tests/engine.test.mjs          # rules, side pots, deck and tournament simulations
tests/sw-files.test.mjs        # every site file is cached for offline use
```

## Tests

```sh
node tests/engine.test.mjs
```

Plays ~30,000 random hands and 300 tournaments, checking chip conservation, unique cards, legal actions, side-pot winners and placings. Deploys are blocked if it fails.

## Run locally

```sh
cd public && python3 -m http.server 8000
```

Open http://localhost:8000. ES modules need a server; opening `index.html` from disk won't work.

## Deploying

Every push to `main` runs `.github/workflows/deploy.yml`, which syntax-checks the JS and publishes `public/` to GitHub Pages. You can also trigger it by hand from the **Actions** tab (Run workflow).

## Playing

- **Host:** open the site, pick stakes, enter your name, tap **Start game**. Tap the `•••` menu and **Invite friends** to share the link (it ends in your table number, like `#1203877`).
- **Friends:** open the link, pick a name and avatar, tap **Join table**, then tap any **+** to sit down.
- **Bots:** as host, tap an empty **+** to add a bot. Handy for testing alone or filling seats. Tap a bot to remove it.
- **Fold:** tap **Fold**, or swipe your cards up.
- **Hide your cards:** tap them (or press `H`). Tap again to peek.
- **Tournament:** pick Tournament in the lobby, choose a speed (blinds up every 5, 10 or 15 minutes), seat players, then tap **Start tournament**. No rebuys or late entries; last player standing wins.
- **Invite in person:** `•••` > **Show QR code**, or the QR button in the lobby.
- **Save & resume:** tables you host save automatically on your device and appear under **Your tables** in the lobby.
- **No internet (same Wi-Fi):** everyone opens OnTilt once while online so it's saved on their phone. Later, without internet:
  1. Host: `•••` > **Show QR code**. With no internet it switches to nearby mode by itself (or tap **No internet? Pair nearby**).
  2. Guest: scan the code with the phone camera. Their screen shows a reply code.
  3. Host: point the camera (already open on the same screen) at the reply code. Repeat for each player.
  The same QR also works when the guest has internet: they connect online, and only fall back to Wi-Fi if that's slow.
- **History:** `•••` > **Hand history** shows the last 15 hands.
- **Sound & vibration:** toggle from `•••`. On iPhone (any browser, iOS 18+) vibration uses light system haptic taps, since iOS browsers don't support the web vibration API.
- **Desktop:** wide screens use the same open layout as phones, widened, with an action bar at the bottom. Shortcuts: `F` fold, `C` or `Space` check/call, `R` min-raise, `↑` custom raise, `Enter` confirm, `H` hide cards, `Esc` close.
- **Raise:** tap **Raise** for a min-raise, or **↑** for the slider with ½ Pot / Pot / All in.
- **Reactions:** tap the smiley in your player box.
- **Ledger:** `•••` > **Ledger** shows buy-ins and net results, for settling up afterward.

## How it works

- The host's browser is the dealer. It shuffles with `crypto.getRandomValues`, enforces the rules (blinds, min-raises, side pots, showdown), and sends each player only their own hole cards.
- Connections are WebRTC via [Trystero](https://github.com/dmotz/trystero), which uses public Nostr relays just to introduce players. Game data then flows directly between browsers.
- The host's table is saved in their browser. If the host closes the tab, play pauses; opening the same link again resumes it and players reconnect automatically.
- 25-second shot clock. Disconnected players are auto-checked or folded.

## Notes

- The host could technically see everyone's cards, so play with people you trust. Chips are play money.
- Players on different networks (mobile data, strict or corporate Wi-Fi) often can't connect directly. They need a TURN relay, or the guest sees "Found the host, but your networks won't connect directly".

## Add a TURN server (recommended)

1. Create a free account at [metered.ca/stun-turn](https://www.metered.ca/stun-turn) and create an app.
2. Copy its credentials URL: `https://<app>.metered.live/api/v1/turn/credentials?apiKey=...`
3. Save it as a repo secret: `gh secret set TURN_CREDENTIALS_URL` (paste when prompted), then re-run the deploy. The workflow writes it into `config.js` at build time so it never lands in git.

You can also list servers directly in `TURN_SERVERS` (e.g. your own [coturn](https://github.com/coturn/coturn)). The key is still visible in the deployed page source, so set a usage cap with your provider.

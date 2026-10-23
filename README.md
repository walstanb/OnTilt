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
    avatars.js       # minimal face avatars (SVG), keyed by short ids
    lan.js           # offline Wi-Fi connections: WebRTC with the handshake carried in QR codes
    scan.js          # camera QR scanner (BarcodeDetector, or bundled jsQR)
    morph.js         # tiny DOM patcher so re-renders keep elements (and their transitions)
    engine.js        # Hold'em rules engine (pure logic, no DOM)
    ui-helpers.js    # formatting, icons, card markup, toast, storage
    voice.js         # voice chat: mic streams over the WebRTC room, mute, speaking detection
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

- **Host:** open the site, pick stakes, enter your name, tap **Start game**. Tap the `•••` menu and **Invite friends** to share the link (it ends in your table number and host key, like `#1203877.5cc5c6d6f8107e91`).
- **Friends:** open the link, pick a name and avatar, tap **Join table**, then tap any **+** to sit down.
- **Bots:** as host, tap an empty **+** to add a bot. Handy for testing alone or filling seats. Tap a bot to remove it.
- **Fold:** tap **Fold**, or swipe your cards up.
- **Showdown:** the table says who won and with what ("flint wins with Two Pair · Queens & 5s"); the five winning cards stay bright and every revealed hand is labelled.
- **Show your cards:** after folding (or winning uncalled), tap **Show cards** and everyone sees them when the hand ends.
- **Your odds:** tap your own avatar during a hand. OnTilt simulates thousands of possible turns/rivers and opponent hands and shows your chance to win plus your most likely final hands; it updates as cards come out.
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
- **Hand rankings:** the ⓘ button in the top-left corner of your player box, or tap your hand's name (e.g. "Two Pair"), shows every hand from Royal Flush to High Card with yours highlighted.
- **Raises** must at least double the current bet (opening bets are at least one big blind).
- **Live actions:** each seat shows what that player just did (Raise, Call, All in…), and the line under the pot says it in words ("lolaa raises to 40").
- **Pre-actions:** while others act, pick Check / Fold or Call any (Fold, Call X or Call any when facing a bet). It fires when your turn comes if it still applies; a pre-call is cancelled if the amount changes.
- **Voice chat**: tap the mic in the bottom-right of your box to join (your browser asks for the microphone), tap again to mute. Audio goes straight between players over the table's WebRTC connections. Players in voice get a mic badge and a green ring while talking. Tap a player to **Mute for me** (only you stop hearing them) or **Mute for everyone** (turns their mic off; they can turn it back on). Once someone unmutes themselves after being muted, nobody can mute them for everyone again for 4 minutes. Not available in offline (Wi-Fi QR) mode.
- **Settings** (`•••` > **Settings**): card backs (Classic Red is the default; Stripes, Cobalt, Mint, Sunny, Ink; saved per device), shown on undealt board cards and your hidden hand and sound & vibration toggles. On iPhone (any browser, iOS 18+) vibration uses light system haptic taps, since iOS browsers don't support the web vibration API.
- **Desktop:** wide screens use the same open layout as phones, widened, with an action bar at the bottom. Shortcuts: `F` fold, `C` or `Space` check/call, `R` min-raise, `↑` custom raise, `Enter` confirm, `H` hide cards, `Esc` close.
- **Raise:** tap **Raise** for a min-raise, or **↑** for the slider with ½ Pot / Pot / All in.
- **Reactions:** tap the smiley in your player box.
- **Ledger:** `•••` > **Ledger** shows buy-ins and net results, for settling up afterward.
- **Sit out:** `•••` > **Sit out next hand** in cash games; tap **I’m back** to rejoin.

## How it works

- The host signs every update with a key made for the table; the invite link carries its fingerprint, so other players can't pretend to be the host. Guests only send their seat token to that verified host.
- The host's browser is the dealer. It shuffles with `crypto.getRandomValues`, enforces the rules (blinds, min-raises, side pots, showdown), and sends each player only their own hole cards.
- Connections are WebRTC via [Trystero](https://github.com/dmotz/trystero), which uses public Nostr relays just to introduce players. Game data then flows directly between browsers.
- The host's table is saved in their browser. If the host closes the tab, play pauses; opening the same link again resumes it and players reconnect automatically. For 20 seconds after it reopens, nobody is auto-folded or dealt out while they reconnect.
- **Backup host:** with other players online, the host keeps one of them (the backup) updated with a card-free copy of the table and signs an endorsement of the backup's own key. Hosts send a heartbeat every 2 seconds; if the host is gone (tab closed: instantly; silent connection: after 6 seconds) the backup takes over 5 seconds later: an unfinished hand is cancelled and bets are returned, then play continues. Guests accept the new host because its key chains back to the original host's key from the invite link. If the old host comes back, it sees the newer host's beacon and rejoins as a player. (Wi-Fi-only guests can't follow a new host; they re-scan the QR.)
- 25-second shot clock. Disconnected players are auto-checked or folded.

## Notes

- The host could technically see everyone's cards, so play with people you trust. Chips are play money.
- Players on different networks (mobile data, strict or corporate Wi-Fi) often can't connect directly. They need a TURN relay, or the guest sees "Found the host, but your networks won't connect directly".

## Add a TURN server (recommended)

1. Create a free account at [metered.ca/stun-turn](https://www.metered.ca/stun-turn) and create an app.
2. Copy its credentials URL: `https://<app>.metered.live/api/v1/turn/credentials?apiKey=...`
3. Save it as a repo secret: `gh secret set TURN_CREDENTIALS_URL` (paste when prompted), then re-run the deploy. The workflow writes it into `config.js` at build time so it never lands in git.

You can also list servers directly in `TURN_SERVERS` (e.g. your own [coturn](https://github.com/coturn/coturn)). The key is still visible in the deployed page source, so set a usage cap with your provider.

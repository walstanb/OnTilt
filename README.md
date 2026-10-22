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
    desktop.css      # wide-screen layout: oval table + action dock, hover states
    motion.css       # animations and transitions
  js/
    config.js        # app ID, relays, TURN servers, shot clock
    morph.js         # tiny DOM patcher so re-renders keep elements (and their transitions)
    engine.js        # Hold'em rules engine (pure logic, no DOM)
    ui-helpers.js    # formatting, icons, card markup, toast, storage
    app.js           # networking, host loop, rendering, input
  assets/favicon.svg
.github/workflows/deploy.yml   # deploys public/ to Pages on every push to main
```

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
- **Fold:** tap **Fold**, or swipe your cards down.
- **Desktop:** on wide screens the game uses an oval table with an action bar at the bottom. Shortcuts: `F` fold, `C` or `Space` check/call, `R` min-raise, `↑` custom raise, `Enter` confirm, `Esc` close.
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
3. Paste it into `TURN_CREDENTIALS_URL` in `public/js/config.js`, commit and push. The deploy runs automatically.

You can also list servers directly in `TURN_SERVERS` (e.g. your own [coturn](https://github.com/coturn/coturn)). The key is visible in the page source, so use a provider that lets you cap usage.

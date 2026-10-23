// App-wide constants.
export const APP_ID = 'ontilt-p2p-v1';
export const TRYSTERO_URL = 'https://esm.sh/trystero@0.26.0';
export const TURN_MS = 25000;

// Nostr relays used only to introduce players to each other. Everyone must use the same list.
export const RELAY_URLS = [
  'wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://relay.snort.social',
  'wss://nostrcity-club.fly.dev', 'wss://relay.routstr.com',
];

// TURN relays carry game traffic when two players can't connect directly
// (different networks, mobile data, strict Wi-Fi). Without one, those players can't join.
// Leave this empty in git: the deploy workflow fills it from the TURN_CREDENTIALS_URL repo secret
// (https://<app>.metered.live/api/v1/turn/credentials?apiKey=...). For local testing, paste it here but don't commit it.
export const TURN_CREDENTIALS_URL = '';
// Or list servers directly: [{ urls:'turn:host:3478', username:'u', credential:'p' }]
export const TURN_SERVERS = [];

// How long a joining player waits before we explain what might be wrong (we keep trying after).
export const JOIN_HINT_MS = 15000;

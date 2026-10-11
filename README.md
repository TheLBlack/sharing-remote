# Remote Share PoC

WebRTC remote desktop. The video and audio are media tracks. Input goes over two DataChannels: `move` is unordered with `maxRetransmits: 0`, and `input` is reliable and ordered. The signaling server only exchanges SDP/ICE and handles pairing.

- `server.js`: signaling server, static pages, `/ice` config. Its only dependency is `ws`.
- `public/source.html`: the Source side. It runs in Chrome, captures the screen and system audio, and asks you to approve each controller.
- `public/controller.html`: the Controller side. It runs in Chrome on macOS and does not need root.
- `agent/agent.py`: the input injector on the Source machine (pynput). It listens only on `127.0.0.1` and checks the page's Origin.

## Run

```bash
npm install
node server.js
```

On the Source machine:

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r agent/requirements.txt
python agent/agent.py                      # --monitor N, --origin https://your-signal-host
```
Open `/source.html`, click **Choose screen & start**, and read the 6-digit code. The code lasts 5 minutes and works once. After 5 failed attempts from one IP, that IP is blocked for 60 s.

On the Mac controller, open `/controller.html`, enter the code and approve the request on the Source. Then:

- **Capture keyboard** turns on fullscreen and the Keyboard Lock API, so Cmd+Tab and similar keys go to the Source.
- **Ctrl+Alt+Esc** leaves capture mode.
- **⌘ → Ctrl** maps Cmd to Ctrl for Windows or Linux Sources.

### Secure context

`getDisplayMedia` and Keyboard Lock only work on `https://` or `localhost`. You have two options:
- LAN: run `server.js` on the Source machine and open `http://localhost:8080/source.html` there. On the Mac, open `http://<source-ip>:8080/controller.html`. WebRTC works over plain http, but keyboard lock does not, so start Chrome with `--unsafely-treat-insecure-origin-as-secure=http://<source-ip>:8080`, or use TLS.
- TLS: `TLS_CERT=cert.pem TLS_KEY=key.pem node server.js`. Pass the agent `--origin https://host:8080`.

## STUN / TURN

```bash
ICE_SERVERS='[{"urls":"stun:stun.l.google.com:19302"},
  {"urls":["turn:turn.example.com:3478?transport=udp","turn:turn.example.com:3478?transport=tcp"],
   "username":"u","credential":"p"}]' node server.js
```
To run a TURN server for testing, use coturn: `turnserver -n --lt-cred-mech --user u:p --realm x --listening-port 3478 --external-ip <public-ip>`.

- **direct only** (controller checkbox): both peers drop the `turn:` URLs. If P2P fails, the controller shows an error and never uses a relay.
- `?relay=1` on both pages: forces `iceTransportPolicy: relay`, which lets you test the TURN fallback deliberately.
- The stats bar shows direct/relay, the candidate types, UDP/TCP (or the protocol to TURN), RTT, FPS, bitrate, loss, resolution and the encoder/decoder.

Direct UDP P2P will not work in every network. Symmetric NAT and UDP-blocking firewalls need TURN.

## Protocol v1 (JSON, `v: 1` on every message)

| channel | message |
|---|---|
| move (lossy) | `{t:"move", seq, x, y}`: x and y are normalized 0..1 to the video frame. The Source drops a message if its seq is older than one already seen. |
| input (reliable) | `{t:"button", b:"left"\|"right"\|"middle", down, x?, y?}` |
| | `{t:"wheel", dx, dy}` (in lines) |
| | `{t:"key", code, key, down, repeat?}`: `code` is the physical `KeyboardEvent.code` |
| | `{t:"release-all"}` |
| | Source → controller: `{t:"hello", w, h, agent}`, `{t:"resize", w, h}` |

Coordinates are normalized, so Retina/HiDPI and resolution changes need no extra handling. The agent multiplies by the monitor's geometry: points on macOS, physical pixels on Windows (DPI-aware) and pixels on X11.

Keys are sent as physical codes and resolved to US-position characters, which pynput then maps through the Source's active layout.

Stuck keys are prevented on several levels:
- The controller releases everything on blur, hide, unload, Meta keyup and disconnect.
- The Source page sends `release-all` when the DataChannel or peer closes, or on kill.
- The agent releases everything when the page WebSocket closes.

## Status

Verified here:
- The server starts and serves the pages and `/ice`.
- Pairing works.
- A wrong code is rejected, and the 6th attempt hits the rate limit.
- `agent.py` compiles.

Not verified (needs the two real machines):
- Video/audio streaming.
- Input injection.
- LAN and cross-network connections.
- TURN fallback.
- Behaviour when permissions are denied.
- Dropping the connection while a key is held.
- Hardware encoding: Chrome picks it automatically, and you can check it in the `enc:` field.

Known limits:
- Mouse mapping assumes you share an entire monitor, and the agent maps to the primary monitor or `--monitor`.
- Chrome only offers system audio on Windows/ChromeOS, and on macOS 14.2+ in recent Chrome. On Linux it depends on the setup.
- Wayland is not supported by pynput.
- Reconnect needs the Source to approve again.

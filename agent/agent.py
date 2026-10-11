import argparse
import asyncio
import json
import platform
import sys

if platform.system() == "Windows":
    import ctypes
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        ctypes.windll.user32.SetProcessDPIAware()

import websockets
from pynput.keyboard import Controller as KB, Key, KeyCode
from pynput.mouse import Controller as Mouse, Button
from screeninfo import get_monitors

PROTOCOL_VERSION = 1

SPECIAL = {
    "Enter": Key.enter, "NumpadEnter": Key.enter, "Escape": Key.esc, "Backspace": Key.backspace,
    "Tab": Key.tab, "Space": Key.space, "Delete": Key.delete, "Insert": getattr(Key, "insert", None),
    "Home": Key.home, "End": Key.end, "PageUp": Key.page_up, "PageDown": Key.page_down,
    "ArrowUp": Key.up, "ArrowDown": Key.down, "ArrowLeft": Key.left, "ArrowRight": Key.right,
    "ShiftLeft": Key.shift_l, "ShiftRight": Key.shift_r, "ControlLeft": Key.ctrl_l, "ControlRight": Key.ctrl_r,
    "AltLeft": Key.alt_l, "AltRight": getattr(Key, "alt_gr", Key.alt_r) if platform.system() != "Darwin" else Key.alt_r,
    "MetaLeft": Key.cmd_l, "MetaRight": Key.cmd_r, "CapsLock": Key.caps_lock,
    "PrintScreen": getattr(Key, "print_screen", None), "ScrollLock": getattr(Key, "scroll_lock", None),
    "Pause": getattr(Key, "pause", None), "ContextMenu": getattr(Key, "menu", None), "NumLock": getattr(Key, "num_lock", None),
    **{f"F{i}": getattr(Key, f"f{i}") for i in range(1, 21) if hasattr(Key, f"f{i}")},
}

US = {
    **{f"Key{c}": c.lower() for c in "ABCDEFGHIJKLMNOPQRSTUVWXYZ"},
    **{f"Digit{d}": str(d) for d in range(10)},
    **{f"Numpad{d}": str(d) for d in range(10)},
    "Minus": "-", "Equal": "=", "BracketLeft": "[", "BracketRight": "]", "Backslash": "\\",
    "Semicolon": ";", "Quote": "'", "Backquote": "`", "Comma": ",", "Period": ".", "Slash": "/",
    "IntlBackslash": "<", "NumpadAdd": "+", "NumpadSubtract": "-", "NumpadMultiply": "*",
    "NumpadDivide": "/", "NumpadDecimal": ".",
}

BUTTONS = {"left": Button.left, "right": Button.right, "middle": Button.middle}


class Injector:
    def __init__(self, monitor):
        self.kb = KB()
        self.mouse = Mouse()
        self.mon = monitor
        self.keys = {}
        self.buttons = set()

    def point(self, m):
        return (self.mon.x + m["x"] * self.mon.width, self.mon.y + m["y"] * self.mon.height)

    def resolve_key(self, m):
        code = m.get("code", "")
        if code in SPECIAL and SPECIAL[code] is not None:
            return SPECIAL[code]
        if code in US:
            return KeyCode.from_char(US[code])
        key = m.get("key") or ""
        if len(key) == 1:
            return KeyCode.from_char(key)
        return None

    def handle(self, m):
        t = m.get("t")
        if t == "move":
            self.mouse.position = self.point(m)
        elif t == "button":
            b = BUTTONS.get(m.get("b"))
            if not b:
                return
            if "x" in m:
                self.mouse.position = self.point(m)
            if m.get("down"):
                self.buttons.add(b)
                self.mouse.press(b)
            elif b in self.buttons:
                self.buttons.discard(b)
                self.mouse.release(b)
        elif t == "wheel":
            dx, dy = m.get("dx", 0), m.get("dy", 0)
            self.mouse.scroll(round(dx) if abs(dx) >= 1 else 0, -round(dy) if abs(dy) >= 1 else (-1 if dy > 0 else 1 if dy < 0 else 0))
        elif t == "key":
            code = m.get("code", "")
            if m.get("down"):
                k = self.keys.get(code) or self.resolve_key(m)
                if k is None:
                    return
                self.keys[code] = k
                self.kb.press(k)
            else:
                k = self.keys.pop(code, None)
                if k is not None:
                    self.kb.release(k)
        elif t == "release-all":
            self.release_all()

    def release_all(self):
        for k in list(self.keys.values()):
            try:
                self.kb.release(k)
            except Exception:
                pass
        for b in list(self.buttons):
            try:
                self.mouse.release(b)
            except Exception:
                pass
        self.keys.clear()
        self.buttons.clear()


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--monitor", type=int, default=None, help="index from the printed list (default: primary)")
    ap.add_argument("--origin", action="append", default=None, help="allowed page origin, e.g. https://signal.example.com (repeatable)")
    a = ap.parse_args()

    mons = get_monitors()
    for i, mon in enumerate(mons):
        print(f"[{i}] {mon.width}x{mon.height} at ({mon.x},{mon.y}){' primary' if mon.is_primary else ''}")
    mon = mons[a.monitor] if a.monitor is not None else next((x for x in mons if x.is_primary), mons[0])
    print(f"mapping input to {mon.width}x{mon.height} at ({mon.x},{mon.y})")

    origins = a.origin or ["http://localhost:8080", "http://127.0.0.1:8080"]
    print(f"allowed origins: {origins}")
    inj = Injector(mon)

    async def serve(ws):
        origin = ws.request.headers.get("Origin")
        if origin not in origins:
            print(f"rejected origin {origin}")
            await ws.close(4003, "origin not allowed")
            return
        print(f"source page connected from {origin}")
        try:
            async for raw in ws:
                try:
                    m = json.loads(raw)
                except ValueError:
                    continue
                if m.get("v") != PROTOCOL_VERSION:
                    await ws.send(json.dumps({"t": "error", "error": f"protocol v{m.get('v')} unsupported"}))
                    continue
                try:
                    inj.handle(m)
                except Exception as e:
                    print("input error:", e, m, file=sys.stderr)
        finally:
            inj.release_all()
            print("source page disconnected, released all input")

    async with websockets.serve(serve, "127.0.0.1", a.port):
        print(f"agent listening on ws://127.0.0.1:{a.port}")
        if platform.system() == "Darwin":
            print("macOS: grant Accessibility to the terminal/python running this agent (System Settings → Privacy & Security → Accessibility)")
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())

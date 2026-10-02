// A tiny Chrome DevTools client that runs *inside* a dot's cloud computer (Python stdlib only).
// It lets the runtime open URLs, read page text, and fill login forms in the sandbox's Chrome.
// Credentials are passed through a temp file (never on the command line) and deleted right away.

export const CDP_HELPER_PATH = "/home/user/.dots/cdp.py";

export const CDP_HELPER = String.raw`
import base64, json, os, socket, struct, sys, time, urllib.request

PORT = 9222

def targets():
    return json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list", timeout=10))

def page():
    pages = [t for t in targets() if t.get("type") == "page" and not t.get("url", "").startswith("devtools://")]
    return pages[0] if pages else None

class WS:
    def __init__(self, url):
        hostport, path = url[len("ws://"):].split("/", 1)
        host, port = hostport.split(":")
        self.s = socket.create_connection((host, int(port)), timeout=60)
        key = base64.b64encode(os.urandom(16)).decode()
        self.s.sendall((f"GET /{path} HTTP/1.1\r\nHost: {hostport}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                        f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        resp = b""
        while b"\r\n\r\n" not in resp:
            resp += self.s.recv(4096)
        self.buf = resp.split(b"\r\n\r\n", 1)[1]
        self.n = 0

    def _read(self, k):
        while len(self.buf) < k:
            chunk = self.s.recv(65536)
            if not chunk:
                raise RuntimeError("connection closed")
            self.buf += chunk
        out, self.buf = self.buf[:k], self.buf[k:]
        return out

    def send(self, obj):
        data = json.dumps(obj).encode()
        head = bytearray([0x81])
        n = len(data)
        if n < 126:
            head.append(0x80 | n)
        elif n < 65536:
            head.append(0x80 | 126); head += struct.pack(">H", n)
        else:
            head.append(0x80 | 127); head += struct.pack(">Q", n)
        mask = os.urandom(4)
        self.s.sendall(bytes(head) + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def recv(self):
        msg = b""
        while True:
            b1, b2 = self._read(2)
            n = b2 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._read(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._read(8))[0]
            if b2 & 0x80:
                self._read(4)
            payload = self._read(n)
            op = b1 & 0x0F
            if op == 8:
                raise RuntimeError("closed")
            if op in (0, 1):
                msg += payload
                if b1 & 0x80:
                    return json.loads(msg)

    def call(self, method, params=None):
        self.n += 1
        self.send({"id": self.n, "method": method, "params": params or {}})
        while True:
            m = self.recv()
            if m.get("id") == self.n:
                if "error" in m:
                    raise RuntimeError(m["error"].get("message", "CDP error"))
                return m.get("result", {})

def evaluate(expr):
    p = page()
    if not p:
        return None
    r = WS(p["webSocketDebuggerUrl"]).call("Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": True})
    return r.get("result", {}).get("value")

def info():
    return evaluate("({url: location.href, title: document.title})") or {}

cmd = sys.argv[1]
if cmd == "ready":
    urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/version", timeout=3)
    print("ok")
elif cmd == "open":
    url = sys.argv[2]
    p = page()
    if p:
        WS(p["webSocketDebuggerUrl"]).call("Page.navigate", {"url": url})
    else:
        urllib.request.urlopen(urllib.request.Request(f"http://127.0.0.1:{PORT}/json/new?{url}", method="PUT"), timeout=10)
    for _ in range(40):
        time.sleep(0.25)
        try:
            if evaluate("document.readyState") in ("interactive", "complete"):
                break
        except Exception:
            pass
    time.sleep(0.6)
    print(json.dumps(info()))
elif cmd == "text":
    print(json.dumps(evaluate("({url: location.href, title: document.title, text: document.body ? document.body.innerText : ''})") or {}))
elif cmd == "js":
    path = sys.argv[2]
    with open(path) as f:
        code = f.read()
    os.remove(path)
    print(json.dumps(evaluate(code) or {}))
`;

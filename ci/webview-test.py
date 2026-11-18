"""Drives the Voicebook page inside the Android app (WebView, via Chrome DevTools)
and checks that the phone voice reads passage after passage."""
import json, sys, time, urllib.request
import websocket  # pip install websocket-client

out = open("out/webview.txt", "w")
def note(*a):
    line = " ".join(str(x) for x in a)
    print(line, flush=True)
    out.write(line + "\n"); out.flush()

pages = []
for attempt in range(20):
    try:
        pages = json.load(urllib.request.urlopen("http://localhost:9222/json", timeout=10))
        if any(p.get("type") == "page" for p in pages): break
    except Exception as e:
        note("devtools not ready:", e)
    time.sleep(3)
note("pages:", json.dumps([{k: p.get(k) for k in ("type", "url", "title")} for p in pages]))
page = next((p for p in pages if p.get("type") == "page"), None)
if not page:
    note("RESULT failed: no page"); sys.exit(1)
ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=60, suppress_origin=True)
seq = 0

def ev(expr, wait=True):
    global seq
    seq += 1
    ws.send(json.dumps({"id": seq, "method": "Runtime.evaluate", "params": {"expression": expr, "awaitPromise": wait, "returnByValue": True}}))
    while True:
        m = json.loads(ws.recv())
        if m.get("id") == seq:
            r = m.get("result", {}).get("result", {})
            return r.get("value", r.get("description"))

say = note

say("page:", ev("location.href"), "| title:", ev("document.title"), "| native bridge:", ev("typeof window.VBNative"))
say("text:", ev("document.body ? document.body.innerText.slice(0, 300) : 'no body'"))
say("browser:", ev("navigator.userAgent"))
for i in range(10):
    if ev("!!window.__voicebook"): break
    time.sleep(3)
say("app loaded:", ev("!!window.__voicebook"))
say("app info:", ev("window.VBNative && window.VBNative.info()"))
ev("[...document.querySelectorAll('button')].find(b => b.textContent.includes('Try a sample story'))?.click()")
time.sleep(3)
ev("(() => { const e = window.__voicebook; e.native.refresh(); e.native.setTier('fast'); e.setProvider('native'); return e.provider; })()")
say("engines:", ev("window.__voicebook.availableProviders().join(', ')"), "| chosen:", ev("window.__voicebook.provider"))
say("characters:", ev("window.__voicebook.characters.map(c => c.name).join(', ')"))
ev("window.__voicebook.play()")
t0 = time.time()
ok = False
last = None
while time.time() - t0 < 240:
    time.sleep(3)
    s = ev("(() => { const e = window.__voicebook; return JSON.stringify({i: e.index, by: e.spokenBy, prov: e.provider, buf: e.buffering, playing: e.playing, wait: e.waitMessage, pct: e.waitPercent, ahead: e.readyAhead, err: e.error, notice: e.notice}); })()")
    if s != last:
        say(f"{time.time() - t0:5.0f}s", s)
        last = s
    d = json.loads(s)
    if d["err"]:
        break
    if d["i"] >= 6 and d["by"] == "native":
        ok = True
        break
say("RESULT", "ok" if ok else "failed")
sys.exit(0 if ok else 1)

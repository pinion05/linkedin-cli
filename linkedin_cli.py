#!/usr/bin/env python3
"""
linkedin-cli — LinkedIn posting CLI via an isolated real-browser client (CDP).

Command: linkedin-cli (short alias: licli)

Design (B-plan, validated 2026-10-22):
  - Owns a dedicated Chrome instance (profile ~/.local/share/linkedin-cli/chrome-profile,
    port 9223) running under xvfb — never touches the user's interactive browser.
  - All LinkedIn traffic is issued BY REAL CHROME (UI automation), so the
    session survives (external API clients get li_at invalidated after 1 call
    on this account — measured).
  - Session auto-revive: LinkedIn + Google One Tap restores login on visit.

Commands:
  linkedin-cli browser start|stop|status   manage the isolated browser
  linkedin-cli status                      session check (+ auto-revive)
  linkedin-cli me                          print profile info
  linkedin-cli post --text "..."           publish a post
  linkedin-cli delete --text "..."         delete own post matching text
"""
import argparse
import json
import os
import subprocess
import sys
import time
import urllib.request

import websockets

HOME = os.environ.get("LINKEDIN_CLI_HOME",
                      os.path.expanduser("~/.local/share/linkedin-cli"))
# legacy licli data dir keeps the seeded browser profile/session
if os.path.isdir(os.path.expanduser("~/.local/share/licli/chrome-profile")):
    HOME = os.path.expanduser("~/.local/share/licli")
PROFILE = os.path.join(HOME, "chrome-profile")
PORT = int(os.environ.get("LICLI_PORT", "9223"))

COMPOSE_URL = "https://www.linkedin.com/sharing/compose"


def activity_url(pg=None) -> str:
    """Own recent-activity URL: env override, cached vanity, else /feed/ (auto-detect helper below)."""
    env = os.environ.get("LINKEDIN_CLI_ACTIVITY_URL")
    if env:
        return env
    cache = os.path.join(HOME, "config.json")
    try:
        cfg = json.load(open(cache))
        if cfg.get("vanity"):
            return f"https://www.linkedin.com/in/{cfg['vanity']}/recent-activity/all/"
    except Exception:
        pass
    return "https://www.linkedin.com/feed/"


async def detect_and_cache_vanity(pg):
    """Find own /in/<vanity> link on any LinkedIn page and cache it."""
    href = await pg.eval_js(
        "(function(){var a=Array.from(document.querySelectorAll('a[href*=\"/in/\"]')).filter(function(x){"
        "var t=(x.innerText||'').trim();var h=x.getAttribute('href');"
        "return t.length>1 && t.indexOf(String.fromCharCode(10))>0 && h.indexOf('/in/')===0 && h.split('/').length<=4 && x.getBoundingClientRect().width>0;})[0];"
        "return a?a.getAttribute('href').split('?')[0]:'';})()")
    if href and "/in/" in href:
        vanity = href.rstrip("/").split("/in/")[-1]
        try:
            os.makedirs(HOME, exist_ok=True)
            json.dump({"vanity": vanity}, open(os.path.join(HOME, "config.json"), "w"))
        except Exception:
            pass
        return vanity
    return ""


# ---------------------------------------------------------------- browser life

def cdp_up() -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/version", timeout=2) as r:
            return r.status == 200
    except Exception:
        return False


def browser_cmd(action: str):
    if action == "status":
        print(json.dumps({"cdp_up": cdp_up(), "port": PORT}))
        return
    if action == "start":
        if cdp_up():
            print(json.dumps({"ok": True, "already_running": True}))
            return
        os.makedirs(HOME, exist_ok=True)
        subprocess.run(["rm", "-f", os.path.join(PROFILE, "SingletonLock")], check=False)
        cmd = [
            "xvfb-run", "-a", "-s", "-screen 0 1400x900x24",
            "google-chrome",
            f"--user-data-dir={PROFILE}",
            "--profile-directory=Default",
            f"--remote-debugging-port={PORT}",
            "--no-first-run", "--no-default-browser-check",
            "--window-size=1400,900", "--disable-dev-shm-usage",
            "about:blank",
        ]
        # detached: survives CLI exit and parent session death
        subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         start_new_session=True)
        for _ in range(20):
            if cdp_up():
                time.sleep(1)
                print(json.dumps({"ok": True, "started": True}))
                return
            time.sleep(1)
        print(json.dumps({"ok": False, "error": "CDP did not come up"}))
        sys.exit(1)
    if action == "stop":
        subprocess.run(["pkill", "-f", f"user-data-dir={PROFILE}"], check=False)
        print(json.dumps({"ok": True, "stopped": True}))


# ---------------------------------------------------------------- CDP helpers

class Page:
    """Attach to (or create) the licli tab and drive it."""

    def __init__(self):
        if not cdp_up():
            # auto-start the isolated browser (detached, survives CLI exit)
            browser_cmd("start")
        if not cdp_up():
            print(json.dumps({"ok": False, "error": "browser failed to start"}))
            sys.exit(2)
        self.ws = None
        self.mid = 0
        self.target_url = None

    def _pick_target(self):
        with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list", timeout=5) as r:
            targets = json.load(r)
        pages = [t for t in targets if t["type"] == "page" and "linkedin.com" in t["url"]]
        if pages:
            return pages[0]
        pages = [t for t in targets if t["type"] == "page" and t["url"] != "devtools://"]
        if pages:
            return pages[0]
        # create a tab (PUT required on modern Chrome)
        req = urllib.request.Request(f"http://127.0.0.1:{PORT}/json/new?about:blank", method="PUT")
        with urllib.request.urlopen(req, timeout=5) as r:
            return json.load(r)

    async def __aenter__(self):
        t = self._pick_target()
        self.target_url = t["url"]
        self.ws = await websockets.connect(t["webSocketDebuggerUrl"], max_size=64 * 1024 * 1024)
        return self

    async def __aexit__(self, *exc):
        if self.ws:
            await self.ws.close()

    async def cmd(self, method, params=None):
        self.mid += 1
        await self.ws.send(json.dumps({"id": self.mid, "method": method, "params": params or {}}))
        while True:
            msg = json.loads(await self.ws.recv())
            if msg.get("id") == self.mid:
                if "error" in msg:
                    raise RuntimeError(f"CDP {method}: {msg['error']}")
                return msg.get("result", {})

    async def eval_js(self, expr: str, await_promise=False, timeout=30):
        res = await self.cmd("Runtime.evaluate", {
            "expression": expr,
            "awaitPromise": await_promise,
            "returnByValue": True,
            "timeout": timeout * 1000,
        })
        if res.get("exceptionDetails"):
            raise RuntimeError(res["exceptionDetails"].get("exception", {}).get("description", "eval error")[:300])
        return res.get("result", {}).get("value")

    async def goto(self, url: str, settle=4.0):
        await self.cmd("Page.enable")
        await self.cmd("Page.navigate", {"url": url})
        time.sleep(settle)
        for _ in range(10):
            state = await self.eval_js("document.readyState")
            if state == "complete":
                break
            time.sleep(1)

    async def click(self, x: float, y: float):
        base = {"x": x, "y": y, "button": "left", "clickCount": 1}
        await self.cmd("Input.dispatchMouseEvent", {**base, "type": "mousePressed"})
        time.sleep(0.12)
        await self.cmd("Input.dispatchMouseEvent", {**base, "type": "mouseReleased"})
        time.sleep(0.6)

    async def press_escape(self):
        for t in ("keyDown", "keyUp"):
            await self.cmd("Input.dispatchKeyEvent", {
                "type": t, "key": "Escape", "code": "Escape",
                "windowsVirtualKeyCode": 27, "nativeVirtualKeyCode": 27})
        time.sleep(0.4)

    async def click_center(self, js_center_expr: str) -> bool:
        """Evaluate JS returning 'x y' center coords, then trusted-click. Empty/None → False."""
        xy = await self.eval_js(js_center_expr)
        if not xy or " " not in str(xy):
            return False
        x, y = str(xy).split(" ")[:2]
        await self.click(float(x), float(y))
        return True


# ---------------------------------------------------------------- LinkedIn ops

FIND_BTN_BY_TEXT = """
(function(){
  var needle = %s;
  var hits = Array.from(document.querySelectorAll('div,span')).filter(function(e){
    return e.childElementCount===0 && (e.textContent||'').indexOf(needle)>=0;});
  if(!hits.length) return '';
  var n = hits[0];
  for(var i=0;i<16 && n;i++){
    var h = n.getBoundingClientRect().height;
    if(h > 900) break;  // climbed past the card into the feed container — bail
    var btn = Array.from(n.querySelectorAll('button')).find(function(b){
      return /관리 메뉴/.test(b.getAttribute('aria-label')||'');});
    if(btn){var r=btn.getBoundingClientRect();
      if(r.width>0) return Math.round(r.x+r.width/2)+' '+Math.round(r.y+r.height/2);}
    n = n.parentElement;
  }
  return '';
})()
"""

MENU_DELETE_ITEM = """
(function(){
  var items = Array.from(document.querySelectorAll('[role=menuitem],[role=menu] button,li button')).filter(function(e){
    return /^삭제$|글 삭제|게시물 삭제|Delete post/.test((e.innerText||'').trim());});
  if(!items.length) return '';
  var r = items[0].getBoundingClientRect();
  return Math.round(r.x+r.width/2)+' '+Math.round(r.y+r.height/2);
})()
"""

CONFIRM_DELETE = """
(function(){
  var btns = Array.from(document.querySelectorAll('button')).filter(function(b){
    return (b.innerText||'').trim()==='삭제' && b.getBoundingClientRect().width>0;});
  if(!btns.length) return '';
  btns.sort(function(a,b){
    var ra=a.getBoundingClientRect(), rb=b.getBoundingClientRect();
    return (rb.y+rb.x)-(ra.y+ra.x);});
  var r = btns[0].getBoundingClientRect();
  return Math.round(r.x+r.width/2)+' '+Math.round(r.y+r.height/2);
})()
"""

PUBLISH_BUTTON = """
(function(){
  var bs = Array.from(document.querySelectorAll('button')).filter(function(x){
    return x.innerText.trim()==='게시물' && x.getBoundingClientRect().width>0;});
  if(!bs.length) return '';
  bs.sort(function(a,b){
    var ra=a.getBoundingClientRect(), rb=b.getBoundingClientRect();
    return (rb.y+rb.x)-(ra.y+ra.x);});
  var r = bs[0].getBoundingClientRect();
  return Math.round(r.x+r.width/2)+' '+Math.round(r.y+r.height/2);
})()
"""


async def get_cookie(pg: Page, name: str) -> str:
    res = await pg.cmd("Network.getCookies", {"urls": ["https://www.linkedin.com"]})
    for c in res.get("cookies", []):
        if c["name"] == name:
            return c["value"]
    return ""


async def session_ok(pg: Page) -> bool:
    """Login verdict = auth cookie exists (li_at). In-page fetch without app
    headers gets 403 regardless of session, so don't probe the API here."""
    return bool(await get_cookie(pg, "li_at"))


async def ensure_session(pg: Page, timeout=60) -> bool:
    if await session_ok(pg):
        return True
    await pg.goto("https://www.linkedin.com/", settle=6)
    deadline = time.time() + timeout
    while time.time() < deadline:
        if await session_ok(pg):
            return True
        time.sleep(4)
    return False


async def cmd_status(pg: Page):
    ok = await ensure_session(pg)
    print(json.dumps({"session_ok": ok, "port": PORT}, ensure_ascii=False))
    if not ok:
        sys.exit(3)


async def cmd_me(pg: Page):
    if not await ensure_session(pg):
        print(json.dumps({"ok": False, "error": "no session"}))
        sys.exit(3)
    url = await pg.eval_js("location.href") or ""
    if "linkedin.com/feed" not in url:
        await pg.goto("https://www.linkedin.com/feed/", settle=4)
    info = await pg.eval_js("""
      (function(){
        var a = Array.from(document.querySelectorAll('a[href*="/in/"]')).filter(function(x){
          var t=(x.innerText||'').trim();
          var href=x.getAttribute('href');
          return t.length>1 && t.indexOf(String.fromCharCode(10))>0
            && href.indexOf('/in/')===0 && href.split('/').length<=4
            && x.getBoundingClientRect().width>0;})[0];
        if(!a) return '';
        var href = a.getAttribute('href').split('?')[0];
        var lines = (a.innerText||'').split('\\n').map(function(s){return s.trim();}).filter(Boolean);
        return JSON.stringify({profileUrl: href, name: lines[0]||'', headline: lines[1]||''});
      })()
    """)
    d = json.loads(info) if info else {}
    d.update({"ok": True, "session": True})
    print(json.dumps(d, ensure_ascii=False))


async def cmd_post(pg: Page, text: str):
    if not await ensure_session(pg):
        print(json.dumps({"ok": False, "error": "no session"}))
        sys.exit(3)
    await pg.goto(COMPOSE_URL, settle=4)

    editor = '.tiptap.ProseMirror[contenteditable=true]'
    ok = await pg.click_center(
        f"(function(){{var e=document.querySelector('{editor}');if(!e)return '';"
        f"var r=e.getBoundingClientRect();return Math.round(r.x+r.width/2)+' '+Math.round(r.y+r.height/2);}})()")
    if not ok:
        print(json.dumps({"ok": False, "error": "composer editor not found"}))
        sys.exit(4)
    await pg.cmd("Input.insertText", {"text": text})
    time.sleep(1.2)

    btn = await pg.eval_js(PUBLISH_BUTTON)
    if not btn:
        print(json.dumps({"ok": False, "error": "publish button not found"}))
        sys.exit(4)
    x, y = btn.split(" ")
    await pg.click(float(x), float(y))

    # verify: our text appears outside the composer (feed/toast), editor gone or cleared
    deadline = time.time() + 25
    posted = False
    while time.time() < deadline:
        time.sleep(3)
        state = await pg.eval_js(
            "(function(){var e=document.querySelector('" + editor + "');"
            "var gone=!e||!e.innerText.trim();"
            "var toast=/게시되었습니다|게시했습니다/.test(document.body.innerText);"
            "var onFeed=document.body.innerText.indexOf(" + json.dumps(text[:20], ensure_ascii=False) + ")>=0;"
            "return JSON.stringify({gone:gone,toast:toast,onFeed:onFeed});})()")
        s = json.loads(state or "{}")
        if s.get("gone") and (s.get("toast") or s.get("onFeed")):
            posted = True
            break
    print(json.dumps({"ok": posted, "detail": s if not posted else "published"}, ensure_ascii=False))
    sys.exit(0 if posted else 5)


async def wait_clickable(pg: Page, js_expr: str, tries=8, delay=0.6) -> str:
    """Poll a JS expr returning 'x y' coords until non-empty; returns coords or ''."""
    for _ in range(tries):
        xy = await pg.eval_js(js_expr)
        if xy and " " in str(xy):
            return str(xy)
        time.sleep(delay)
    return ""


async def cmd_delete(pg: Page, text: str):
    if not await ensure_session(pg):
        print(json.dumps({"ok": False, "error": "no session"}))
        sys.exit(3)
    url = await pg.eval_js("location.href") or ""
    if "linkedin.com" not in url:
        await pg.goto("https://www.linkedin.com/", settle=4)
    if activity_url(pg).endswith("/feed/"):  # no cached vanity yet → detect
        await detect_and_cache_vanity(pg)
    await pg.goto(activity_url(pg), settle=5)
    needle = json.dumps(text, ensure_ascii=False)

    err = "unknown"
    for attempt in range(3):
        await pg.press_escape()  # dismiss stray video/modal overlays
        xy = await wait_clickable(pg, FIND_BTN_BY_TEXT % needle, tries=4)
        if not xy:
            err = "post/options not found"
            continue
        x, y = xy.split(" ")
        await pg.click(float(x), float(y))

        xy = await wait_clickable(pg, MENU_DELETE_ITEM, tries=4)
        if not xy:
            err = "delete menu item not found"
            continue
        x, y = xy.split(" ")
        await pg.click(float(x), float(y))

        xy = await wait_clickable(pg, CONFIRM_DELETE, tries=4)
        if not xy:
            err = "confirm dialog not found"
            continue
        x, y = xy.split(" ")
        await pg.click(float(x), float(y))
        err = None
        break

    if err:
        print(json.dumps({"ok": False, "error": err}))
        sys.exit(4)

    deadline = time.time() + 20
    gone = False
    while time.time() < deadline:
        time.sleep(3)
        idx = await pg.eval_js(f"document.body.innerText.indexOf({needle})")
        toast = await pg.eval_js("/삭제했습니다/.test(document.body.innerText)")
        if idx == -1 or toast:
            gone = True
            break
    print(json.dumps({"ok": gone}, ensure_ascii=False))
    sys.exit(0 if gone else 5)


# ---------------------------------------------------------------- main

async def amain():
    ap = argparse.ArgumentParser(prog="licli")
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("browser")
    b.add_argument("action", choices=["start", "stop", "status"])
    sub.add_parser("status")
    sub.add_parser("me")
    p = sub.add_parser("post")
    p.add_argument("--text", required=True)
    d = sub.add_parser("delete")
    d.add_argument("--text", required=True)
    args = ap.parse_args()

    if args.cmd == "browser":
        browser_cmd(args.action)
        return

    async with Page() as pg:
        await pg.cmd("Runtime.enable")
        handler = {"status": cmd_status, "me": cmd_me,
                   "post": lambda g: cmd_post(g, args.text),
                   "delete": lambda g: cmd_delete(g, args.text)}[args.cmd]
        await handler(pg)


if __name__ == "__main__":
    import asyncio
    asyncio.run(amain())

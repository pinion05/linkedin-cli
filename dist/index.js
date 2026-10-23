#!/usr/bin/env node
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PROFILE = exports.HOME = void 0;
/**
 * licli / linkedin-cli — LinkedIn posting CLI via an isolated real-browser
 * CDP client. All LinkedIn traffic is issued BY REAL CHROME, so the session
 * survives (external API clients get li_at invalidated after ~1 call).
 * Session auto-revive: LinkedIn + Google One Tap restores login on visit.
 *
 * Validated 2026-10-22/23: post / edit / delete / status / me, browser
 * lifecycle, forced-session-death auto-recovery.
 */
const node_child_process_1 = require("node:child_process");
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const ws_1 = __importDefault(require("ws"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LEGACY_HOME = node_path_1.default.join(node_os_1.default.homedir(), ".local/share/licli");
const DEFAULT_HOME = node_path_1.default.join(node_os_1.default.homedir(), ".local/share/linkedin-cli");
exports.HOME = process.env.LINKEDIN_CLI_HOME && node_fs_1.default.existsSync(node_path_1.default.join(process.env.LINKEDIN_CLI_HOME, "chrome-profile"))
    ? process.env.LINKEDIN_CLI_HOME
    : node_fs_1.default.existsSync(node_path_1.default.join(LEGACY_HOME, "chrome-profile"))
        ? LEGACY_HOME
        : DEFAULT_HOME;
exports.PROFILE = node_path_1.default.join(exports.HOME, "chrome-profile");
const PORT = parseInt(process.env.LICLI_PORT || "9223", 10);
const COMPOSE_URL = "https://www.linkedin.com/sharing/compose";
// ---------------------------------------------------------------- selectors
// (button texts measured on the Korean UI — see README 함정 기록)
const EDITOR_SEL = ".tiptap.ProseMirror[contenteditable=true]";
const FIND_BTN_BY_TEXT = (needle) => `
(function(){
  var needle = ${JSON.stringify(needle)};
  var btns = Array.from(document.querySelectorAll('button[aria-label*="관리 메뉴"]'));
  for (var i=0;i<btns.length;i++){
    var n = btns[i];
    for (var j=0;j<8 && n;j++){
      if ((n.innerText||'').indexOf(needle)>=0){
        btns[i].scrollIntoView({block:'center'});
        const r = btns[i].getBoundingClientRect();
        if (r.width>0) return Math.round(r.x+r.width/2)+' '+Math.round(r.y+r.height/2);
        return '';
      }
      if (n.getBoundingClientRect().height > 900) break;
      n = n.parentElement;
    }
  }
  return '';
})()`;
const MENU_DELETE_ITEM = `
(function(){
  var items = Array.from(document.querySelectorAll('[role=menuitem],[role=menu] button,li button')).filter(function(e){
    return /^삭제$|글 삭제|게시물 삭제|Delete post/.test((e.innerText||'').trim());});
  if(!items.length) return '';
  var r = items[0].getBoundingClientRect();
  return Math.round(r.x+r.width/2)+' '+Math.round(r.y+r.height/2);
})()`;
const CONFIRM_DELETE = `
(function(){
  var btns = Array.from(document.querySelectorAll('button')).filter(function(b){
    return (b.innerText||'').trim()==='삭제' && b.getBoundingClientRect().width>0;});
  if(!btns.length) return '';
  btns.sort(function(a,b){
    var ra=a.getBoundingClientRect(), rb=b.getBoundingClientRect();
    return (rb.y+rb.x)-(ra.y+ra.x);});
  var r = btns[0].getBoundingClientRect();
  return Math.round(r.x+r.width/2)+' '+Math.round(r.y+r.height/2);
})()`;
const PUBLISH_BUTTON = `
(function(){
  var bs = Array.from(document.querySelectorAll('button')).filter(function(x){
    return x.innerText.trim()==='게시물' && x.getBoundingClientRect().width>0;});
  if(!bs.length) return '';
  bs.sort(function(a,b){
    var ra=a.getBoundingClientRect(), rb=b.getBoundingClientRect();
    return (rb.y+rb.x)-(ra.y+ra.x);});
  var r = bs[0].getBoundingClientRect();
  return Math.round(r.x+r.width/2)+' '+Math.round(r.y+r.height/2);
})()`;
// ---------------------------------------------------------------- browser life
async function cdpUp() {
    try {
        const r = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(2000) });
        return r.ok;
    }
    catch {
        return false;
    }
}
async function browserCmd(action) {
    if (action === "status") {
        console.log(JSON.stringify({ cdp_up: await cdpUp(), port: PORT }));
        return;
    }
    if (action === "start") {
        if (await cdpUp()) {
            console.log(JSON.stringify({ ok: true, already_running: true }));
            return;
        }
        node_fs_1.default.mkdirSync(exports.HOME, { recursive: true });
        try {
            node_fs_1.default.rmSync(node_path_1.default.join(exports.PROFILE, "SingletonLock"), { force: true });
        }
        catch { /* ignore */ }
        const child = (0, node_child_process_1.spawn)("xvfb-run", ["-a", "-s", "-screen 0 1400x900x24", "google-chrome",
            `--user-data-dir=${exports.PROFILE}`, "--profile-directory=Default",
            `--remote-debugging-port=${PORT}`, "--no-first-run", "--no-default-browser-check",
            "--window-size=1400,900", "--disable-dev-shm-usage", "about:blank"], { detached: true, stdio: "ignore" });
        child.unref();
        for (let i = 0; i < 20; i++) {
            if (await cdpUp()) {
                await sleep(1000);
                console.log(JSON.stringify({ ok: true, started: true }));
                return;
            }
            await sleep(1000);
        }
        console.error(JSON.stringify({ ok: false, error: "CDP did not come up" }));
        process.exit(1);
    }
    if (action === "stop") {
        try {
            (0, node_child_process_1.execSync)(`pkill -f "user-data-dir=${exports.PROFILE}"`, { stdio: "ignore" });
        }
        catch { /* ignore */ }
        console.log(JSON.stringify({ ok: true, stopped: true }));
    }
}
async function listTargets() {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(5000) });
    return (await r.json());
}
class Page {
    ws;
    mid = 0;
    pending = new Map();
    static async open() {
        if (!(await cdpUp())) {
            await browserCmd("start");
            if (!(await cdpUp())) {
                console.error(JSON.stringify({ ok: false, error: "browser failed to start" }));
                process.exit(2);
            }
        }
        let targets = await listTargets();
        let pages = targets.filter((t) => t.type === "page" && t.url.includes("linkedin.com"));
        if (!pages.length)
            pages = targets.filter((t) => t.type === "page" && !t.url.startsWith("devtools://"));
        let target;
        if (pages.length) {
            target = pages[0];
        }
        else {
            const r = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" });
            target = (await r.json());
        }
        const pg = new Page();
        await pg.connect(target.webSocketDebuggerUrl);
        return pg;
    }
    connect(url) {
        return new Promise((resolve, reject) => {
            this.ws = new ws_1.default(url, { maxPayload: 64 * 1024 * 1024 });
            this.ws.on("open", () => resolve());
            this.ws.on("error", reject);
            this.ws.on("message", (data) => {
                const msg = JSON.parse(data.toString());
                if (msg.id !== undefined && this.pending.has(msg.id)) {
                    const p = this.pending.get(msg.id);
                    this.pending.delete(msg.id);
                    if (msg.error)
                        p.reject(new Error(`CDP ${msg.error.message}`));
                    else
                        p.resolve(msg.result ?? {});
                }
            });
        });
    }
    async close() {
        if (!this.ws)
            return;
        await new Promise((resolve) => {
            const t = setTimeout(resolve, 2000); // safety: never hang on close
            this.ws.once("close", () => { clearTimeout(t); resolve(); });
            try {
                this.ws.close();
            }
            catch {
                resolve();
            }
        });
    }
    cmd(method, params = {}) {
        return new Promise((resolve, reject) => {
            const id = ++this.mid;
            this.pending.set(id, { resolve, reject });
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }
    async evalJs(expr, awaitPromise = false) {
        const res = await this.cmd("Runtime.evaluate", {
            expression: expr, awaitPromise, returnByValue: true,
        });
        if (res.exceptionDetails) {
            const d = res.exceptionDetails.exception?.description || "eval error";
            throw new Error(String(d).slice(0, 300));
        }
        return res.result?.value;
    }
    async goto(url, settle = 4) {
        await this.cmd("Page.enable");
        await this.cmd("Page.navigate", { url });
        await sleep(settle * 1000);
        for (let i = 0; i < 10; i++) {
            if ((await this.evalJs("document.readyState")) === "complete")
                break;
            await sleep(1000);
        }
    }
    async click(x, y) {
        const base = { x, y, button: "left", clickCount: 1 };
        await this.cmd("Input.dispatchMouseEvent", { ...base, type: "mousePressed" });
        await sleep(120);
        await this.cmd("Input.dispatchMouseEvent", { ...base, type: "mouseReleased" });
        await sleep(600);
    }
    async clickCenter(jsExpr) {
        const xy = await this.evalJs(jsExpr);
        if (!xy || !xy.includes(" "))
            return false;
        const [x, y] = xy.split(" ");
        await this.click(parseFloat(x), parseFloat(y));
        return true;
    }
    async pressEscape() {
        for (const t of ["keyDown", "keyUp"]) {
            await this.cmd("Input.dispatchKeyEvent", {
                type: t, key: "Escape", code: "Escape",
                windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
            });
        }
        await sleep(400);
    }
    async keyCombo(key, code, vk, ctrl = true) {
        const mods = ctrl ? 2 : 0;
        await this.cmd("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods });
        await this.cmd("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods });
    }
    async insertText(text) {
        await this.cmd("Input.insertText", { text });
    }
}
// ---------------------------------------------------------------- LinkedIn ops
async function getCookie(pg, name) {
    const res = await pg.cmd("Network.getCookies", { urls: ["https://www.linkedin.com"] });
    for (const c of res.cookies || [])
        if (c.name === name)
            return c.value;
    return "";
}
async function sessionOk(pg) {
    // Login verdict = auth cookie exists (li_at, httpOnly — visible via CDP only)
    return Boolean(await getCookie(pg, "li_at"));
}
async function ensureSession(pg, timeoutS = 60) {
    if (await sessionOk(pg))
        return true;
    await pg.goto("https://www.linkedin.com/", 6);
    const deadline = Date.now() + timeoutS * 1000;
    while (Date.now() < deadline) {
        if (await sessionOk(pg))
            return true;
        await sleep(4000);
    }
    return false;
}
function cachedVanity() {
    try {
        const cfg = JSON.parse(node_fs_1.default.readFileSync(node_path_1.default.join(exports.HOME, "config.json"), "utf8"));
        return cfg.vanity || null;
    }
    catch {
        return null;
    }
}
async function detectAndCacheVanity(pg) {
    const href = (await pg.evalJs(`
    (function(){var a=Array.from(document.querySelectorAll('a[href*="/in/"]')).filter(function(x){
      var t=(x.innerText||'').trim();var h=x.getAttribute('href');
      return t.length>1 && t.indexOf(String.fromCharCode(10))>0 && h.indexOf('/in/')>=0
        && (h.split('/in/')[1]||'').split('/').filter(Boolean).length===1
        && x.getBoundingClientRect().width>0;})[0];
    return a?a.getAttribute('href').split('?')[0]:'';})()`)) || "";
    if (href.includes("/in/")) {
        const vanity = href.replace(/\/+$/, "").split("/in/").pop();
        try {
            node_fs_1.default.mkdirSync(exports.HOME, { recursive: true });
            node_fs_1.default.writeFileSync(node_path_1.default.join(exports.HOME, "config.json"), JSON.stringify({ vanity }));
        }
        catch { /* ignore */ }
        return vanity;
    }
    return "";
}
async function activityUrl(pg) {
    const env = process.env.LINKEDIN_CLI_ACTIVITY_URL;
    if (env)
        return env;
    const vanity = cachedVanity();
    if (vanity)
        return `https://www.linkedin.com/in/${vanity}/recent-activity/all/`;
    return "https://www.linkedin.com/feed/";
}
async function requireSession(pg) {
    if (!(await ensureSession(pg))) {
        console.log(JSON.stringify({ ok: false, error: "no session" }));
        process.exit(3);
    }
}
async function cmdStatus(pg) {
    const ok = await ensureSession(pg);
    console.log(JSON.stringify({ session_ok: ok, port: PORT }));
    if (!ok)
        process.exit(3);
}
async function cmdMe(pg) {
    await requireSession(pg);
    const url = (await pg.evalJs("location.href")) || "";
    if (!url.includes("linkedin.com/feed"))
        await pg.goto("https://www.linkedin.com/feed/", 4);
    const info = (await pg.evalJs(`
    (function(){
      var a = Array.from(document.querySelectorAll('a[href*="/in/"]')).filter(function(x){
        var t=(x.innerText||'').trim();var href=x.getAttribute('href');
        return t.length>1 && t.indexOf(String.fromCharCode(10))>0
          && href.indexOf('/in/')>=0 && (href.split('/in/')[1]||'').split('/').filter(Boolean).length===1
          && x.getBoundingClientRect().width>0;})[0];
      if(!a) return '';
      var href = a.getAttribute('href').split('?')[0];
      var lines = (a.innerText||'').split('\\n').map(function(s){return s.trim();}).filter(Boolean);
      return JSON.stringify({profileUrl: href, name: lines[0]||'', headline: lines[1]||''});
    })()`)) || "";
    const d = info ? JSON.parse(info) : {};
    console.log(JSON.stringify({ ok: true, session: true, ...d }));
}
async function cmdPost(pg, text) {
    await requireSession(pg);
    await pg.goto(COMPOSE_URL, 4);
    // 2026-10-23: trusted mouse clicks no longer focus the editor / open menus
    // (measured) → JS focus() + Input.insertText + synthetic click()
    const FOCUS_EDITOR = `
    (function(){var e=document.querySelector('${EDITOR_SEL}');
    if(!e)return false;e.focus();return document.activeElement===e;})()`;
    let focused = false;
    for (let i = 0; i < 10; i++) {
        focused = Boolean(await pg.evalJs(FOCUS_EDITOR));
        if (focused)
            break;
        await sleep(1000);
    }
    if (!focused) {
        console.log(JSON.stringify({ ok: false, error: "composer editor not found" }));
        process.exit(4);
    }
    await pg.insertText(text);
    await sleep(1500);
    const clicked = (await pg.evalJs(`
    (function(){var bs=Array.from(document.querySelectorAll('button')).filter(function(x){
      return x.innerText.trim()==='게시물' && x.getBoundingClientRect().width>0 && !x.disabled;});
    if(!bs.length)return '';
    bs.sort(function(a,b){var ra=a.getBoundingClientRect(),rb=b.getBoundingClientRect();
      return (rb.y+rb.x)-(ra.y+ra.x);});
    bs[0].click();return 'CLICKED';})()`)) || "";
    if (clicked !== "CLICKED") {
        console.log(JSON.stringify({ ok: false, error: "publish button not found" }));
        process.exit(4);
    }
    const deadline = Date.now() + 25000;
    let state = {};
    let posted = false;
    while (Date.now() < deadline) {
        await sleep(3000);
        const s = (await pg.evalJs(`(function(){var e=document.querySelector('${EDITOR_SEL}');` +
            `var gone=!e||!e.innerText.trim();` +
            `var toast=/게시되었습니다|게시했습니다/.test(document.body.innerText);` +
            `var onFeed=document.body.innerText.indexOf(${JSON.stringify(text.slice(0, 20))})>=0;` +
            `return JSON.stringify({gone:gone,toast:toast,onFeed:onFeed});})()`)) || "{}";
        state = JSON.parse(s);
        if (state.gone && (state.toast || state.onFeed)) {
            posted = true;
            break;
        }
    }
    console.log(JSON.stringify({ ok: posted, detail: posted ? "published" : state }));
    process.exit(posted ? 0 : 5);
}
async function waitClickable(pg, jsExpr, tries = 8, delayMs = 600) {
    for (let i = 0; i < tries; i++) {
        const xy = (await pg.evalJs(jsExpr)) || "";
        if (xy.includes(" "))
            return xy;
        await sleep(delayMs);
    }
    return "";
}
async function cmdDelete(pg, text) {
    await requireSession(pg);
    const url = (await pg.evalJs("location.href")) || "";
    if (!url.includes("linkedin.com"))
        await pg.goto("https://www.linkedin.com/", 4);
    if (!(await activityUrl(pg)).startsWith("https://www.linkedin.com/in/"))
        await detectAndCacheVanity(pg);
    await pg.goto(await activityUrl(pg), 5);
    // 2026-10-23: 옵션 메뉴는 신뢰 마우스 입력으로 열리지 않게 바뀜(실측) → 합성 click() 사용
    const CLICK_OPTS = `
  (function(){
    var needle = ${JSON.stringify(text)};
    var btns = Array.from(document.querySelectorAll('button[aria-label*="관리 메뉴"]'));
    for (var i=0;i<btns.length;i++){
      var n = btns[i];
      for (var j=0;j<8 && n;j++){
        if ((n.innerText||'').indexOf(needle)>=0){
          if (btns[i].getBoundingClientRect().width>0){ btns[i].click(); return 'CLICKED'; }
          return '';
        }
        if (n.getBoundingClientRect().height > 900) break;
        n = n.parentElement;
      }
    }
    return '';
  })()`;
    const CLICK_MENU_DELETE = `
  (function(){
    var items = Array.from(document.querySelectorAll('[role=menuitem],[role=menu] button,li button')).filter(function(e){
      return /^삭제$|글 삭제|게시물 삭제|Delete post/.test((e.innerText||'').trim());});
    if(!items.length) return '';
    items[0].click();
    return 'CLICKED';
  })()`;
    const CLICK_CONFIRM = `
  (function(){
    var btns = Array.from(document.querySelectorAll('button')).filter(function(b){
      return (b.innerText||'').trim()==='삭제' && b.getBoundingClientRect().width>0;});
    if(!btns.length) return '';
    btns.sort(function(a,b){
      var ra=a.getBoundingClientRect(), rb=b.getBoundingClientRect();
      return (rb.y+rb.x)-(ra.y+ra.x);});
    btns[0].click();
    return 'CLICKED';
  })()`;
    let err = "unknown";
    for (let attempt = 0; attempt < 3; attempt++) {
        await pg.pressEscape(); // dismiss stray video/modal overlays
        let r = await pg.evalJs(CLICK_OPTS);
        if (r !== "CLICKED") {
            err = "post/options not found";
            continue;
        }
        await sleep(1200);
        r = await pg.evalJs(CLICK_MENU_DELETE);
        if (r !== "CLICKED") {
            err = "delete menu item not found";
            continue;
        }
        await sleep(1500);
        let confirmed = false;
        for (let i = 0; i < 8; i++) {
            r = await pg.evalJs(CLICK_CONFIRM);
            if (r === "CLICKED") {
                confirmed = true;
                break;
            }
            await sleep(600);
        }
        if (!confirmed) {
            err = "confirm dialog not found";
            continue;
        }
        err = "";
        break;
    }
    if (err) {
        console.log(JSON.stringify({ ok: false, error: err }));
        process.exit(4);
    }
    const needleJs = JSON.stringify(text);
    const deadline = Date.now() + 20000;
    let gone = false;
    while (Date.now() < deadline) {
        await sleep(3000);
        const idx = await pg.evalJs(`document.body.innerText.indexOf(${needleJs})`);
        const toast = await pg.evalJs(`/삭제했습니다/.test(document.body.innerText)`);
        if (idx === -1 || toast) {
            gone = true;
            break;
        }
    }
    console.log(JSON.stringify({ ok: gone }));
    process.exit(gone ? 0 : 5);
}
// ---------------------------------------------------------------- main
function usage() {
    console.log(`licli — LinkedIn posting CLI (isolated real-browser CDP client)

usage:
  licli browser start|stop|status   manage the isolated browser
  licli status                      session check (+ auto-revive)
  licli me                          print profile info
  licli post --text "..."           publish a post
  licli delete --text "..."         delete own post matching text`);
}
async function main() {
    const [cmd, ...rest] = process.argv.slice(2);
    if (!cmd || cmd === "help" || cmd === "--help") {
        usage();
        return;
    }
    if (cmd === "browser") {
        await browserCmd(rest[0] || "status");
        return;
    }
    const pg = await Page.open();
    try {
        await pg.cmd("Runtime.enable");
        if (cmd === "status")
            await cmdStatus(pg);
        else if (cmd === "me")
            await cmdMe(pg);
        else if (cmd === "post") {
            const i = rest.indexOf("--text");
            const text = i >= 0 ? rest[i + 1] : "";
            if (!text) {
                console.log(JSON.stringify({ ok: false, error: "post requires --text" }));
                process.exit(1);
            }
            await cmdPost(pg, text);
        }
        else if (cmd === "delete") {
            const i = rest.indexOf("--text");
            const text = i >= 0 ? rest[i + 1] : "";
            if (!text) {
                console.log(JSON.stringify({ ok: false, error: "delete requires --text" }));
                process.exit(1);
            }
            await cmdDelete(pg, text);
        }
        else {
            usage();
            process.exit(1);
        }
    }
    finally {
        await pg.close();
    }
}
main().catch((e) => { console.error(JSON.stringify({ ok: false, error: String(e).slice(0, 200) })); process.exit(1); });

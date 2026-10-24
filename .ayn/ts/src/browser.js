"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Browser = exports.Tab = void 0;
exports.readDevToolsPort = readDevToolsPort;
const chromium_ts_1 = require("./chromium.ts");
const CALL_TIMEOUT_MS = 30_000;
class Tab {
    id;
    #ws;
    #id = 0;
    #pending = new Map();
    #listeners = new Map();
    #closed = false;
    constructor(id, ws) {
        this.id = id;
        this.#ws = ws;
        ws.onmessage = (e) => this.#onMessage(String(e.data));
        ws.onclose = () => this.#failAll(new Error('cdp socket closed'));
    }
    #onMessage(raw) {
        let msg;
        try {
            msg = JSON.parse(raw);
        }
        catch {
            return;
        }
        if (msg === null || typeof msg !== 'object')
            return;
        if (msg.id != null)
            return this.#settle(msg);
        if (msg.method)
            this.#dispatch(msg.method, msg.params);
    }
    #settle(msg) {
        const p = this.#pending.get(msg.id);
        if (!p)
            return;
        this.#pending.delete(msg.id);
        clearTimeout(p.to);
        if (msg.error)
            p.rej(new Error(msg.error.message ?? 'cdp error'));
        else
            p.res(msg.result ?? {});
    }
    #dispatch(method, params) {
        for (const fn of this.#listeners.get(method) ?? []) {
            try {
                fn(params ?? {});
            }
            catch { }
        }
    }
    #failAll(err) {
        this.#closed = true;
        for (const [, p] of this.#pending) {
            clearTimeout(p.to);
            p.rej(err);
        }
        this.#pending.clear();
    }
    send(method, params = {}, timeoutMs = CALL_TIMEOUT_MS) {
        if (this.#closed)
            return Promise.reject(new Error('cdp socket closed'));
        const id = ++this.#id;
        return new Promise((res, rej) => {
            const to = setTimeout(() => {
                this.#pending.delete(id);
                rej(new Error(`${method} timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            this.#pending.set(id, { res, rej, to });
            try {
                this.#ws.send(JSON.stringify({ id, method, params }));
            }
            catch (e) {
                clearTimeout(to);
                this.#pending.delete(id);
                rej(e);
            }
        });
    }
    on(method, fn) {
        let set = this.#listeners.get(method);
        if (!set) {
            set = new Set();
            this.#listeners.set(method, set);
        }
        set.add(fn);
        return () => {
            set.delete(fn);
        };
    }
    once(method) {
        let off;
        const promise = new Promise((res) => {
            off = this.on(method, (p) => {
                off();
                res(p);
            });
        });
        return { promise, cancel: () => off?.() };
    }
    close() {
        if (!this.#closed) {
            this.#closed = true;
            try {
                this.#ws.close();
            }
            catch { }
        }
    }
}
exports.Tab = Tab;
class Browser {
    #proc;
    #port = 0;
    #profile;
    #tabs = new Set();
    #closing = false;
    constructor(profile) {
        this.#profile = profile;
    }
    static async launch({ profile, extraArgs = [], headless = true, }) {
        const browser = new Browser(profile);
        await browser.#start(extraArgs, headless);
        return browser;
    }
    async #start(extraArgs, headless) {
        const bin = (0, chromium_ts_1.resolveChromium)();
        const proc = Bun.spawn([
            bin,
            ...(headless ? ['--headless=new'] : []),
            '--disable-gpu',
            '--no-sandbox',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-extensions',
            '--disable-background-networking',
            '--disable-component-update',
            '--disable-sync',
            '--hide-scrollbars',
            '--force-color-profile=srgb',
            `--user-data-dir=${this.#profile}`,
            '--remote-debugging-port=0',
            'about:blank',
            ...extraArgs,
        ], { stdout: 'ignore', stderr: 'pipe', stdin: 'ignore' });
        this.#proc = proc;
        try {
            this.#port = await readDevToolsPort(proc, 30_000);
            await this.#awaitSession();
        }
        catch (e) {
            this.#proc = undefined;
            try {
                proc.kill('SIGKILL');
            }
            catch { }
            await proc.exited.catch(() => { });
            throw e;
        }
    }
    async #awaitSession(deadlineMs = 30_000) {
        const started = Bun.nanoseconds();
        let last;
        while (Bun.nanoseconds() - started < deadlineMs * 1e6) {
            let tab;
            try {
                tab = await this.newTab();
                await tab.send('Page.enable', {}, 3_000);
                return;
            }
            catch (e) {
                last = e;
            }
            finally {
                if (tab)
                    await this.closeTab(tab).catch(() => { });
            }
            await Bun.sleep(150);
        }
        throw new Error(`chromium page session never became ready: ${last instanceof Error ? last.message : last}`);
    }
    get port() {
        return this.#port;
    }
    async alive(timeoutMs = 2_000) {
        if (!this.#proc || this.#closing)
            return false;
        try {
            const res = await fetch(`http://127.0.0.1:${this.#port}/json/version`, {
                signal: AbortSignal.timeout(timeoutMs),
            });
            return res.ok;
        }
        catch {
            return false;
        }
    }
    async newTab(url = 'about:blank') {
        const res = await fetch(`http://127.0.0.1:${this.#port}/json/new?${encodeURIComponent(url)}`, {
            method: 'PUT',
            signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        });
        if (!res.ok)
            throw new Error(`could not open tab: ${res.status} ${await res.text()}`);
        const target = (await res.json());
        const ws = new WebSocket(target.webSocketDebuggerUrl);
        let tab;
        try {
            tab = await new Promise((res2, rej) => {
                ws.onopen = () => res2(new Tab(target.id, ws));
                ws.onerror = () => rej(new Error('cdp websocket failed to open'));
            });
        }
        catch (e) {
            await fetch(`http://127.0.0.1:${this.#port}/json/close/${target.id}`, {
                signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
            }).catch(() => { });
            throw e;
        }
        this.#tabs.add(tab);
        return tab;
    }
    async closeTab(tab) {
        tab.close();
        this.#tabs.delete(tab);
        await fetch(`http://127.0.0.1:${this.#port}/json/close/${tab.id}`, {
            signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        }).catch(() => { });
    }
    async close() {
        if (this.#closing)
            return;
        this.#closing = true;
        for (const t of this.#tabs)
            t.close();
        this.#tabs.clear();
        const proc = this.#proc;
        if (!proc)
            return;
        try {
            const version = await (await fetch(`http://127.0.0.1:${this.#port}/json/version`, {
                signal: AbortSignal.timeout(3_000),
            })).json();
            const ws = new WebSocket(version.webSocketDebuggerUrl);
            await Promise.race([
                new Promise((res, rej) => {
                    ws.onopen = () => res();
                    ws.onerror = () => rej(new Error('browser endpoint unreachable'));
                }),
                Bun.sleep(3_000).then(() => {
                    throw new Error('devtools socket did not open');
                }),
            ]);
            ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
            await Promise.race([proc.exited, Bun.sleep(5_000)]);
            try {
                ws.close();
            }
            catch { }
        }
        catch { }
        if (!proc.killed) {
            const exited = await Promise.race([
                proc.exited.then(() => true),
                Bun.sleep(4_000).then(() => false),
            ]);
            if (!exited) {
                proc.kill('SIGKILL');
                await Promise.race([proc.exited, Bun.sleep(2_000)]);
            }
        }
    }
}
exports.Browser = Browser;
async function readDevToolsPort(proc, timeoutMs) {
    const stream = proc.stderr;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const deadline = Bun.nanoseconds() + timeoutMs * 1e6;
    let exited = false;
    try {
        while (Bun.nanoseconds() < deadline) {
            const remaining = deadline - Bun.nanoseconds();
            const read = await Promise.race([
                reader.read(),
                proc.exited.then(() => 'exited'),
                Bun.sleep(Math.max(0, remaining / 1e6)).then(() => 'timeout'),
            ]);
            if (read === 'exited') {
                exited = true;
                break;
            }
            if (read === 'timeout')
                break;
            const { value, done } = read;
            if (done)
                break;
            buf += decoder.decode(value, { stream: true });
            const m = buf.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
            if (m) {
                void (async () => {
                    try {
                        for (;;) {
                            const next = await reader.read();
                            if (next.done)
                                return;
                            buf = decoder.decode(next.value, { stream: true });
                        }
                    }
                    catch { }
                })();
                return Number(m[1]);
            }
        }
    }
    catch { }
    if (exited)
        throw new Error('chromium exited before it exposed a DevTools endpoint');
    throw new Error(`chromium exposed no DevTools endpoint in ${timeoutMs}ms:\n${buf.slice(0, 400)}`);
}
//# sourceMappingURL=browser.js.map
import { CHROMIUM, resolveChromium, type Subprocess } from "./chromium.ts";
import type { CdpEvent } from "./types.ts";

const CALL_TIMEOUT_MS = 30_000;

export class Tab {
  readonly id: string;
  readonly #ws: WebSocket;
  #id = 0;
  #pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void; to: ReturnType<typeof setTimeout> }>();
  #listeners = new Map<string, Set<CdpEvent>>();
  #closed = false;

  constructor(id: string, ws: WebSocket) {
    this.id = id;
    this.#ws = ws;
    ws.onmessage = (e) => this.#onMessage(String(e.data));
    ws.onclose = () => this.#failAll(new Error("cdp socket closed"));
  }

  #onMessage(raw: string) {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.id != null) {
      const p = this.#pending.get(msg.id);
      if (!p) return;
      this.#pending.delete(msg.id);
      clearTimeout(p.to);
      if (msg.error) p.rej(new Error(msg.error.message ?? "cdp error"));
      else p.res(msg.result ?? {});
      return;
    }
    if (msg.method) {
      for (const fn of this.#listeners.get(msg.method) ?? []) {
        try { fn(msg.params ?? {}); } catch { /* one bad listener must not break the socket */ }
      }
    }
  }

  #failAll(err: Error) {
    this.#closed = true;
    for (const [, p] of this.#pending) { clearTimeout(p.to); p.rej(err); }
    this.#pending.clear();
  }

  send(method: string, params: Record<string, unknown> = {}, timeoutMs = CALL_TIMEOUT_MS): Promise<any> {
    if (this.#closed) return Promise.reject(new Error("cdp socket closed"));
    const id = ++this.#id;
    return new Promise((res, rej) => {
      const to = setTimeout(() => {
        this.#pending.delete(id);
        rej(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.#pending.set(id, { res, rej, to });
      try { this.#ws.send(JSON.stringify({ id, method, params })); }
      catch (e) { clearTimeout(to); this.#pending.delete(id); rej(e as Error); }
    });
  }

  on(method: string, fn: CdpEvent): () => void {
    let set = this.#listeners.get(method);
    if (!set) { set = new Set(); this.#listeners.set(method, set); }
    set.add(fn);
    return () => { set!.delete(fn); };
  }

  /** Resolve on the next occurrence of an event, with a way to cancel. */
  once(method: string): { promise: Promise<any>; cancel: () => void } {
    let off: (() => void) | undefined;
    const promise = new Promise<any>((res) => { off = this.on(method, (p) => { off!(); res(p); }); });
    return { promise, cancel: () => off?.() };
  }

  close() {
    if (!this.#closed) { this.#closed = true; try { this.#ws.close(); } catch { /* already gone */ } }
  }
}

export class Browser {
  #proc: Subprocess | undefined;
  #port = 0;
  #profile: string;
  #tabs = new Set<Tab>();
  #closing = false;

  constructor(profile: string) { this.#profile = profile; }

  static async launch({ profile, extraArgs = [] }: { profile: string; extraArgs?: string[] }): Promise<Browser> {
    const browser = new Browser(profile);
    await browser.#start(extraArgs);
    return browser;
  }

  async #start(extraArgs: string[]) {
    const bin = resolveChromium();
    const proc = Bun.spawn([
      bin,
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--hide-scrollbars",
      "--force-color-profile=srgb",
      `--user-data-dir=${this.#profile}`,
      "--remote-debugging-port=0",
      "about:blank",
      ...extraArgs,
    ], { stdout: "ignore", stderr: "pipe", stdin: "ignore" });

    this.#proc = proc;
    this.#port = await readDevToolsPort(proc, 30_000);
    await this.#awaitSession();
  }

  /**
   * Chromium prints its DevTools endpoint before a page session will accept
   * commands, so a socket opened immediately can succeed and then never be
   * answered. Poll until a command actually round-trips.
   */
  async #awaitSession(deadlineMs = 30_000) {
    const started = Bun.nanoseconds();
    let last: unknown;
    while (Bun.nanoseconds() - started < deadlineMs * 1e6) {
      try {
        const tab = await this.newTab();
        await tab.send("Page.enable", {}, 3_000);
        await this.closeTab(tab);
        return;
      } catch (e) { last = e; }
      await Bun.sleep(150);
    }
    throw new Error(`chromium page session never became ready: ${last instanceof Error ? last.message : last}`);
  }

  get port() { return this.#port; }

  async newTab(url = "about:blank"): Promise<Tab> {
    const res = await fetch(`http://127.0.0.1:${this.#port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
    if (!res.ok) throw new Error(`could not open tab: ${res.status} ${await res.text()}`);
    const target = await res.json() as { id: string; webSocketDebuggerUrl: string };
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    const tab = await new Promise<Tab>((res2, rej) => {
      ws.onopen = () => res2(new Tab(target.id, ws));
      ws.onerror = () => rej(new Error("cdp websocket failed to open"));
    });
    this.#tabs.add(tab);
    return tab;
  }

  async closeTab(tab: Tab) {
    tab.close();
    this.#tabs.delete(tab);
    await fetch(`http://127.0.0.1:${this.#port}/json/close/${tab.id}`).catch(() => {});
  }

  /**
   * Ask Chromium to close itself over CDP. It then tears down its own zygote,
   * renderer, gpu and network children, which is the only reliable teardown.
   *
   * Process-group signalling is deliberately not used: under Bun.spawn the child
   * shares the parent's group, so kill(-pid) signals the caller's whole process
   * tree. That was measured killing the calling shell, and signalling only the
   * direct parent leaves the browser's children orphaned.
   */
  async close() {
    if (this.#closing) return;
    this.#closing = true;
    for (const t of this.#tabs) t.close();
    this.#tabs.clear();

    const proc = this.#proc;
    if (!proc) return;

    try {
      const version = await (await fetch(`http://127.0.0.1:${this.#port}/json/version`)).json();
      const ws = new WebSocket(version.webSocketDebuggerUrl);
      await new Promise<void>((res, rej) => {
        ws.onopen = () => res();
        ws.onerror = () => rej(new Error("browser endpoint unreachable"));
      });
      ws.send(JSON.stringify({ id: 1, method: "Browser.close" }));
      await Promise.race([proc.exited, Bun.sleep(5_000)]);
      try { ws.close(); } catch { /* socket already torn down with the browser */ }
    } catch { /* fall through to the direct kill */ }

    if (!proc.killed) {
      const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(4_000).then(() => false)]);
      if (!exited) {
        proc.kill("SIGKILL");
        await Promise.race([proc.exited, Bun.sleep(2_000)]);
      }
    }
  }
}

/** Chromium announces its port on stderr; read it natively from the stream. */
export async function readDevToolsPort(proc: Subprocess, timeoutMs: number): Promise<number> {
  const stream = proc.stderr as ReadableStream<Uint8Array>;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const deadline = Bun.nanoseconds() + timeoutMs * 1e6;

  try {
    while (Bun.nanoseconds() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const m = buf.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) return Number(m[1]);
    }
  } catch {
    /* fall through to the error below */
  }
  throw new Error(`chromium exposed no DevTools endpoint in ${timeoutMs}ms:\n${buf.slice(0, 400)}`);
}

export { CHROMIUM };
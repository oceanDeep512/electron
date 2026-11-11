import { agentRuntime, BrowserWindow } from 'electron/main';

import { afterEach, describe, expect, it } from 'vitest';

import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as path from 'node:path';
import type { Duplex } from 'node:stream';
import { pathToFileURL } from 'node:url';
import * as zlib from 'node:zlib';

import { closeAllWindows } from './lib/window-helpers.ts';

const fixturePage = path.join(import.meta.dirname, 'fixtures', 'agent-runtime', 'page.html');
const fixturePreload = path.join(import.meta.dirname, 'fixtures', 'agent-runtime', 'preload.js');
const fixtureUrl = pathToFileURL(fixturePage).href;

type AgentSession = ReturnType<typeof agentRuntime.createSession>;

const openSessions: AgentSession[] = [];

function partitionName(): string {
  return `agentrt${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function createSession(options: { partition?: string; persist?: boolean; persona?: unknown } = {}): AgentSession {
  const created = agentRuntime.createSession({
    partition: options.partition ?? partitionName(),
    persist: options.persist,
    persona: options.persona
  });
  openSessions.push(created);
  return created;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function samplePersona(): Record<string, unknown> {
  return {
    seed: 'seed-1',
    userAgent: 'Mozilla/5.0 AgentRuntime',
    userAgentMetadata: {
      brands: [{ brand: 'Chromium', version: '159' }],
      fullVersionList: [{ brand: 'Chromium', version: '159.0.8140.0' }],
      fullVersion: '159.0.8140.0',
      platform: 'Windows',
      platformVersion: '15.0.0',
      architecture: 'x86',
      bitness: '64',
      model: '',
      mobile: false,
      wow64: false,
      formFactors: ['Desktop']
    },
    acceptLanguages: ['zh-CN'],
    timezone: 'Asia/Shanghai',
    hardwareConcurrency: 8,
    deviceMemory: 8,
    screen: {
      width: 1280,
      height: 720,
      availWidth: 1280,
      availHeight: 680,
      colorDepth: 24,
      deviceScaleFactor: 1
    },
    webgl: { vendor: 'Example', renderer: 'Example Renderer' },
    webgpu: { vendor: 'Example', architecture: 'generic', device: 'device', description: 'description' },
    webrtcIpHandlingPolicy: 'default',
    fontPolicy: 'real'
  };
}

function listen(handler: http.RequestListener): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => {
          server.closeAllConnections();
          server.close(() => done());
        })
      });
    });
  });
}

afterEach(async () => {
  for (const runtimeSession of openSessions.splice(0)) {
    runtimeSession.close();
  }
  await closeAllWindows();
});

describe('agentRuntime checkpoint', () => {
  it('exposes the control plane and leaves websocket and persona off', () => {
    expect(agentRuntime.checkpoint.controlPlane).toBe(true);
    expect(agentRuntime.checkpoint.nativePersona).toBe(false);
    expect(agentRuntime.checkpoint.accessibilitySnapshot).toBe(true);
    expect(agentRuntime.checkpoint.responseBodyObservation).toBe(true);
    expect(agentRuntime.checkpoint.webSocketMessageObservation).toBe(false);
    expect(agentRuntime.checkpoint.baseline).toBe('ef2710fa6c10fe56365a9949fa783d26ca1499e5');
    expect('snapshot' in agentRuntime).toBe(false);
    expect('observe' in agentRuntime).toBe(false);
  });

  it('rejects an empty partition before attaching to the default session', () => {
    expect(() => agentRuntime.createSession({ partition: '' })).toThrow();
    try {
      agentRuntime.resolvePartition({ partition: '' });
      expect.fail('empty partition should be rejected');
    } catch (error) {
      expect(errorCode(error)).toBe('invalid-partition');
    }
    try {
      agentRuntime.createSession({ partition: 'persist:agentrtconflict', persist: false });
      expect.fail('persist flag should conflict with the prefix');
    } catch (error) {
      expect(errorCode(error)).toBe('partition-conflict');
    }
  });

  it('rejects a persona instead of leaving the renderer unchanged', () => {
    const persona = samplePersona();
    expect(agentRuntime.validatePersona(persona).ok).toBe(true);
    const partition = partitionName();
    try {
      agentRuntime.createSession({ partition, persona });
      expect.fail('persona should be unavailable');
    } catch (error) {
      expect(errorCode(error)).toBe('native-persona-unavailable');
    }
    try {
      agentRuntime.createSession({ partition, persona: { seed: 'only' } });
      expect.fail('invalid persona should be rejected');
    } catch (error) {
      expect(errorCode(error)).toBe('invalid-persona');
    }
    const created = createSession({ partition });
    expect(created.personaApplied).toBe(false);
    expect(created.personaId).toBe(null);
  });

  it('reuses an open session and isolates cookies by partition', async () => {
    const partition = partitionName();
    const first = createSession({ partition });
    const second = agentRuntime.createSession({ partition });
    expect(second).toBe(first);
    first.close();
    const recreated = createSession({ partition });
    expect(recreated).not.toBe(first);
    expect(recreated.isClosed).toBe(false);
    const other = createSession();
    await recreated.session.cookies.set({ url: 'http://agent-runtime.test/', name: 'token', value: 'alpha' });
    const copied = await other.session.cookies.get({ url: 'http://agent-runtime.test/', name: 'token' });
    const stored = await recreated.session.cookies.get({ url: 'http://agent-runtime.test/', name: 'token' });
    expect(copied).toEqual([]);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.value).toBe('alpha');
  });

  it('creates a sandboxed page and can adopt a matching WebContents', () => {
    const created = createSession();
    const page = created.createPage({ show: false, width: 640, height: 480 });
    expect(page.adopted).toBe(false);
    expect(page.webContents.debugger.isAttached()).toBe(false);
    const prefs = page.webContents.getLastWebPreferences();
    expect(prefs?.sandbox).toBe(true);
    expect(prefs?.contextIsolation).toBe(true);
    expect(prefs?.webSecurity).toBe(true);
    expect(prefs?.nodeIntegration).toBe(false);
    expect(prefs?.partition).toBe(created.storagePartition);

    const owned = new BrowserWindow({
      show: false,
      webPreferences: {
        partition: created.storagePartition,
        preload: fixturePreload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    });
    const before = owned.webContents.getLastWebPreferences();
    try {
      created.createPage({ webContents: owned.webContents, show: true });
      expect.fail('adoption should not accept window options');
    } catch (error) {
      expect(errorCode(error)).toBe('invalid-size');
    }
    expect(owned.webContents.getLastWebPreferences()).toEqual(before);
    const adopted = created.createPage({ webContents: owned.webContents });
    expect(adopted.adopted).toBe(true);
    expect(owned.webContents.getLastWebPreferences()).toEqual(before);
    adopted.close();
    expect(owned.isDestroyed()).toBe(false);

    const foreign = new BrowserWindow({
      show: false,
      webPreferences: {
        partition: partitionName(),
        preload: fixturePreload
      }
    });
    const foreignBefore = foreign.webContents.getLastWebPreferences();
    try {
      created.createPage({ webContents: foreign.webContents });
      expect.fail('a different partition should be rejected');
    } catch (error) {
      expect(errorCode(error)).toBe('partition-mismatch');
    }
    expect(foreign.webContents.getLastWebPreferences()).toEqual(foreignBefore);
  });
});

describe('agentRuntime navigation', () => {
  it('reports HTTP status from the response and leaves non-HTTP status unavailable', async () => {
    const server = await listen((req, res) => {
      if (req.url === '/created') {
        res.writeHead(201, { 'Content-Type': 'text/plain' });
        res.end('created');
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('missing');
    });
    try {
      const page = createSession().createPage();
      const created = await page.goto(`${server.origin}/created`);
      expect(created.httpStatus).toBe(201);
      expect(created.httpStatusSource).toBe('did-navigate');
      expect(page.webContents.debugger.isAttached()).toBe(false);
      const missing = await page.goto(`${server.origin}/missing`);
      expect(missing.httpStatus).toBe(404);
      const data = await page.goto('data:text/html,hi');
      expect(data.httpStatus).toBe(null);
      expect(data.httpStatusSource).toBe('unavailable');
      const file = await page.goto(fixtureUrl);
      expect(file.httpStatus).toBe(null);
      expect(file.httpStatusSource).toBe('unavailable');
    } finally {
      await server.close();
    }
  });

  it('stops a superseded navigation and rejects work on a destroyed page', async () => {
    const server = await listen((req, res) => {
      if (req.url === '/slow') return;
      res.writeHead(204);
      res.end();
    });
    try {
      const page = createSession().createPage();
      const pending = page.goto(`${server.origin}/slow`, { timeoutMs: 5000 });
      await expect(page.goto(`${server.origin}/slow`)).rejects.toMatchObject({ code: 'navigation-in-progress' });
      await expect(page.locator('#go').boundingBox()).rejects.toMatchObject({ code: 'navigation-in-progress' });
      page.close();
      await expect(pending).rejects.toMatchObject({ code: 'closed' });
      await expect(page.goto('data:text/html,hi')).rejects.toMatchObject({ code: 'destroyed' });
    } finally {
      await server.close();
    }
  });

  it('times out and aborts a navigation that does not commit', async () => {
    const server = await listen(() => undefined);
    try {
      const runtimeSession = createSession();
      const timed = runtimeSession.createPage();
      await expect(timed.goto(`${server.origin}/slow`, { timeoutMs: 200 })).rejects.toMatchObject({ code: 'timeout' });
      const controller = new AbortController();
      const page = runtimeSession.createPage();
      const pending = page.goto(`${server.origin}/slow`, { signal: controller.signal, timeoutMs: 5000 });
      controller.abort();
      await expect(pending).rejects.toMatchObject({ code: 'aborted' });
    } finally {
      await server.close();
    }
  });

  it('rejects an unreachable URL instead of spending the full timeout', async () => {
    const page = createSession().createPage();
    const started = Date.now();
    await expect(page.goto('http://127.0.0.1:1/', { timeoutMs: 5000 })).rejects.toMatchObject({ code: 'navigation-failed' });
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it('fails the attempt when a different main-frame navigation starts', async () => {
    const server = await listen(() => undefined);
    try {
      const page = createSession().createPage();
      const started = new Promise<void>((resolve) => {
        const onStart = (details: Electron.Event & { url: string; isMainFrame: boolean }) => {
          if (details.isMainFrame && details.url.includes('/slow')) {
            page.webContents.removeListener('did-start-navigation', onStart);
            resolve();
          }
        };
        page.webContents.on('did-start-navigation', onStart);
      });
      const pending = page.goto(`${server.origin}/slow`, { timeoutMs: 5000 });
      await started;
      await page.webContents.loadURL('data:text/html,other');
      await expect(pending).rejects.toMatchObject({ code: 'navigation-failed' });
    } finally {
      await server.close();
    }
  });
});

describe('agentRuntime locator', () => {
  it('rejects elements that are missing, hidden, disabled, or not editable', async () => {
    const page = createSession().createPage();
    await page.goto(fixtureUrl);
    await expect(page.locator('#missing').click()).rejects.toMatchObject({ code: 'not-found' });
    await expect(page.locator('#hidden').click()).rejects.toMatchObject({ code: 'not-actionable' });
    await expect(page.locator('#disabled').click()).rejects.toMatchObject({ code: 'not-actionable' });
    await expect(page.locator('#static').fill('x')).rejects.toMatchObject({ code: 'not-editable' });
    const quoted = await page.locator('button[data-label="say \\"hi\\""]').boundingBox();
    expect(quoted.width).toBeGreaterThan(0);
    expect(page.webContents.debugger.isAttached()).toBe(false);
  });

  it('fills and clicks a shown window', { tags: ['serial'] }, async () => {
    const page = createSession().createPage({ show: true });
    await page.goto(fixtureUrl);
    await page.locator('#field').fill('hello');
    expect(await page.locator('#field').inputValue()).toBe('hello');
    await page.locator('#field').press('!');
    expect(await page.locator('#field').inputValue()).toBe('hello!');
    await page.locator('#go').click();
    const html = await page.content();
    expect(html).toContain('clicked');
    expect(page.webContents.debugger.isAttached()).toBe(false);
  });
});

describe('agentRuntime accessibility snapshot', () => {
  it('rejects invalid limits before calling into the page', async () => {
    const page = createSession().createPage();
    await expect(page.snapshot({ maxNodes: 0 })).rejects.toMatchObject({ code: 'invalid-snapshot' });
    await expect(page.snapshot({ framePolicy: 'all' })).resolves.toMatchObject({
      framePolicy: 'all',
      stitching: 'chromium-ax-tree-combiner',
      inlineTextBoxes: 'stripped-by-chromium'
    });
    expect(page.webContents.debugger.isAttached()).toBe(false);
  });

  it('does not resolve a snapshot after close, and rejects a crashed page', async () => {
    const closing = createSession().createPage();
    const pending = closing.snapshot({ timeoutMs: 5000 });
    closing.close();
    await expect(pending).rejects.toMatchObject({ code: 'closed' });

    const crashed = createSession().createPage();
    await crashed.goto('data:text/html,<button>Go</button>');
    await new Promise<void>((resolve) => {
      crashed.webContents.once('render-process-gone', () => resolve());
      crashed.webContents.forcefullyCrashRenderer();
    });
    await expect(crashed.snapshot()).rejects.toMatchObject({ code: 'crashed' });
  });

  it('returns same-origin names and omits a cross-origin frame when asked', async () => {
    const foreign = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><button>Cross Child</button>');
    });
    const main = await listen((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      if (req.url === '/child') {
        res.end('<!doctype html><button>Same Child</button>');
        return;
      }
      res.end(`<!doctype html><title>Snapshot</title><button>Main Go</button><iframe src="/child"></iframe><iframe src="${foreign.origin}/"></iframe>`);
    });
    try {
      const page = createSession().createPage();
      await page.goto(`${main.origin}/`);
      const same = await page.snapshot({ framePolicy: 'same-origin' });
      expect(same.framePolicy).toBe('same-origin');
      expect(same.crossOriginStitch).toBe('linked-when-parent-tree-id-matches');
      expect(same.nodes.some((node) => node.name === 'Main Go')).toBe(true);
      expect(same.nodes.some((node) => node.name === 'Same Child')).toBe(true);
      expect(same.nodes.some((node) => node.name === 'Cross Child')).toBe(false);
      expect(page.webContents.debugger.isAttached()).toBe(false);

      const all = await page.snapshot({ framePolicy: 'all' });
      expect(all.framePolicy).toBe('all');
      expect(all.nodes.some((node) => node.name === 'Main Go')).toBe(true);
      expect(all.crossFrameBounds).toBe('relative-chain-without-transforms');
      const button = all.nodes.find((node) => node.name === 'Main Go');
      expect(button?.role.length).toBeGreaterThan(0);
      expect(button?.parentId === null || typeof button?.parentId === 'number').toBe(true);
    } finally {
      await main.close();
      await foreign.close();
    }
  });
});

function bytesOf(body: Uint8Array | null): number[] {
  return body ? Array.from(body) : [];
}

async function waitFor<T>(read: () => T | undefined): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for a response observation');
}

describe('agentRuntime response bodies', () => {
  it('rejects an invalid capture limit before any request', () => {
    const runtimeSession = createSession();
    expect(() => runtimeSession.observeResponses({ maxBytesPerResponse: 0 }, () => {})).toThrow();
    try {
      runtimeSession.observeResponses({ urls: ['one*two*'] }, () => {});
      expect.fail('a pattern with two stars should be rejected');
    } catch (error) {
      expect(errorCode(error)).toBe('invalid-response-observation');
    }
  });

  it('reads text, empty, binary, and chunked bodies without a webRequest listener', async () => {
    const binary = Buffer.from([0, 255, 128, 65]);
    const server = await listen((req, res) => {
      if (req.url === '/empty') {
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.url === '/bin') {
        res.writeHead(201, { 'content-type': 'application/octet-stream' });
        res.end(binary);
        return;
      }
      if (req.url === '/chunks') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.write('aa');
        setTimeout(() => {
          res.write('bb');
          res.end();
        }, 20);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('hello');
    });
    const runtimeSession = createSession();
    const events: Array<{ phase: string; url: string; body: Uint8Array | null; requestId: string }> = [];
    runtimeSession.observeResponses({ urls: [`${server.origin}/`] }, (event) => {
      events.push(event);
    });
    const page = runtimeSession.createPage();
    try {
      expect(await page.webContents.executeJavaScript(`fetch(${JSON.stringify(`${server.origin}/text`)}).then((response) => response.text())`)).toBe('hello');
      const text = await waitFor(() => events.find((event) => event.phase === 'completed' && event.url.endsWith('/text')));
      expect(Buffer.from(bytesOf(text.body)).toString('utf8')).toBe('hello');

      expect(await page.webContents.executeJavaScript(`fetch(${JSON.stringify(`${server.origin}/empty`)}).then((response) => response.status)`)).toBe(204);
      const empty = await waitFor(() => events.find((event) => event.phase === 'completed' && event.url.endsWith('/empty')));
      expect(bytesOf(empty.body)).toEqual([]);

      const fromPage = await page.webContents.executeJavaScript(`fetch(${JSON.stringify(`${server.origin}/bin`)}).then(async (response) => Array.from(new Uint8Array(await response.arrayBuffer())))`);
      expect(fromPage).toEqual([0, 255, 128, 65]);
      const bin = await waitFor(() => events.find((event) => event.phase === 'completed' && event.url.endsWith('/bin')));
      expect(bytesOf(bin.body)).toEqual([0, 255, 128, 65]);

      expect(await page.webContents.executeJavaScript(`fetch(${JSON.stringify(`${server.origin}/chunks`)}).then((response) => response.text())`)).toBe('aabb');
      const chunks = await waitFor(() => events.find((event) => event.phase === 'completed' && event.url.endsWith('/chunks')));
      expect(Buffer.from(bytesOf(chunks.body)).toString('utf8')).toBe('aabb');
      expect(page.webContents.debugger.isAttached()).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('observes decoded gzip and brotli bodies for an ordinary fetch', async () => {
    const server = await listen((req, res) => {
      if (req.url === '/gzip') {
        res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
        res.end(zlib.gzipSync(Buffer.from('gzip-body')));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'br' });
      res.end(zlib.brotliCompressSync(Buffer.from('br-body')));
    });
    const runtimeSession = createSession();
    const events: Array<{ phase: string; url: string; body: Uint8Array | null; networkDecoded: boolean }> = [];
    runtimeSession.observeResponses({}, (event) => events.push(event));
    const page = runtimeSession.createPage();
    try {
      expect(await page.webContents.executeJavaScript(`fetch(${JSON.stringify(`${server.origin}/gzip`)}).then((response) => response.text())`)).toBe('gzip-body');
      const gzip = await waitFor(() => events.find((event) => event.phase === 'completed' && event.url.endsWith('/gzip')));
      expect(gzip.networkDecoded).toBe(true);
      expect(Buffer.from(bytesOf(gzip.body)).toString('utf8')).toBe('gzip-body');
      expect(await page.webContents.executeJavaScript(`fetch(${JSON.stringify(`${server.origin}/br`)}).then((response) => response.text())`)).toBe('br-body');
      const brotli = await waitFor(() => events.find((event) => event.phase === 'completed' && event.url.endsWith('/br')));
      expect(brotli.networkDecoded).toBe(true);
      expect(Buffer.from(bytesOf(brotli.body)).toString('utf8')).toBe('br-body');
    } finally {
      await server.close();
    }
  });

  it('correlates a redirect without inventing its body', async () => {
    const server = await listen((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: '/final' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('landed');
    });
    const runtimeSession = createSession();
    const events: Array<{ phase: string; requestId: string; url: string; body: Uint8Array | null; status: number }> = [];
    runtimeSession.observeResponses({}, (event) => events.push(event));
    const page = runtimeSession.createPage();
    try {
      expect(await page.webContents.executeJavaScript(`fetch(${JSON.stringify(`${server.origin}/start`)}, { redirect: 'follow' }).then((response) => response.text())`)).toBe('landed');
      const redirect = await waitFor(() => events.find((event) => event.phase === 'redirect'));
      expect(redirect.body).toBe(null);
      expect(redirect.status).toBe(302);
      const completed = await waitFor(() => events.find((event) => event.phase === 'completed' && event.requestId === redirect.requestId));
      expect(Buffer.from(bytesOf(completed.body)).toString('utf8')).toBe('landed');
    } finally {
      await server.close();
    }
  });

  it('keeps the page body when the capture is truncated, skipped, or the listener is slow', async () => {
    let pending: Array<http.ServerResponse> = [];
    let opened: (() => void) | undefined;
    const bothStarted = new Promise<void>((resolve) => {
      opened = resolve;
    });
    const held = await listen((_req, res) => {
      pending.push(res);
      if (pending.length === 2) opened?.();
    });
    const slow = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.write(Buffer.alloc(12, 7));
      setTimeout(() => res.end(Buffer.alloc(8, 7)), 30);
    });
    const runtimeSession = createSession();
    const events: Array<{ phase: string; url: string; body: Uint8Array | null; truncated: boolean; skipReason: string }> = [];
    runtimeSession.observeResponses({ maxBytesPerResponse: 4, maxInFlight: 1, maxAggregateBytes: 4 }, (event) => {
      events.push(event);
    });
    const page = runtimeSession.createPage();
    try {
      const reads = page.webContents.executeJavaScript(`
        Promise.all([
          fetch(${JSON.stringify(`${held.origin}/a`)}).then((response) => response.text()),
          fetch(${JSON.stringify(`${held.origin}/b`)}).then((response) => response.text())
        ])
      `);
      await bothStarted;
      for (const response of pending) {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('abcdefghij');
      }
      expect(await reads).toEqual(['abcdefghij', 'abcdefghij']);
      const completed = await waitFor(() => events.find((event) => event.phase === 'completed'));
      expect(completed.truncated).toBe(true);
      expect(bytesOf(completed.body)).toEqual([97, 98, 99, 100]);
      const skipped = await waitFor(() => events.find((event) => event.phase === 'skipped'));
      expect(skipped.skipReason === 'in-flight-limit' || skipped.skipReason === 'aggregate-limit').toBe(true);
      expect(skipped.body).toBe(null);

      const total = await page.webContents.executeJavaScript(`
        fetch(${JSON.stringify(`${slow.origin}/slow`)}).then(async (response) => {
          const reader = response.body.getReader();
          let count = 0;
          while (true) {
            await new Promise((resolve) => setTimeout(resolve, 10));
            const step = await reader.read();
            if (step.done) break;
            count += step.value.byteLength;
          }
          return count;
        })
      `);
      expect(total).toBe(20);
    } finally {
      await held.close();
      await slow.close();
    }
  });

  it('reports a failed request and a canceled fetch without keeping the page waiting', async () => {
    const server = await listen((req, res) => {
      if (req.url === '/reset') {
        req.socket.destroy();
        return;
      }
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('late');
      }, 300);
    });
    const runtimeSession = createSession();
    const events: Array<{ phase: string; url: string; body: Uint8Array | null }> = [];
    runtimeSession.observeResponses({}, (event) => events.push(event));
    const page = runtimeSession.createPage();
    try {
      const reset = await page.webContents.executeJavaScript(
        `fetch(${JSON.stringify(`${server.origin}/reset`)}).then(() => 'ok', () => 'failed')`
      );
      expect(reset).toBe('failed');
      const aborted = await waitFor(() => events.find((event) => event.url.endsWith('/reset') && (event.phase === 'aborted' || event.phase === 'completed')));
      expect(aborted.phase === 'aborted' || bytesOf(aborted.body).length === 0).toBe(true);
      const canceled = await page.webContents.executeJavaScript(`
        const controller = new AbortController();
        const pending = fetch(${JSON.stringify(`${server.origin}/hang`)}, { signal: controller.signal }).then(() => 'ok', () => 'aborted');
        controller.abort();
        pending
      `);
      expect(canceled).toBe('aborted');
    } finally {
      await server.close();
    }
  });

  it('isolates sessions and leaves the request alone when nothing is subscribed', async () => {
    const server = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('plain');
    });
    const watched = createSession();
    const other = createSession();
    const events: string[] = [];
    watched.observeResponses({}, (event) => {
      if (event.phase === 'completed') events.push(event.url);
    });
    const watchedPage = watched.createPage();
    const otherPage = other.createPage();
    const quiet = createSession().createPage();
    try {
      expect(await quiet.webContents.executeJavaScript(`fetch(${JSON.stringify(`${server.origin}/quiet`)}).then((response) => response.text())`)).toBe('plain');
      expect(await otherPage.webContents.executeJavaScript(`fetch(${JSON.stringify(`${server.origin}/other`)}).then((response) => response.text())`)).toBe('plain');
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(events.some((url) => url.endsWith('/other') || url.endsWith('/quiet'))).toBe(false);
      expect(await watchedPage.webContents.executeJavaScript(`fetch(${JSON.stringify(`${server.origin}/watched`)}).then((response) => response.text())`)).toBe('plain');
      await waitFor(() => events.find((url) => url.endsWith('/watched')));
    } finally {
      await server.close();
    }
  });

  it('still observes when a webRequest listener is installed, and stops after unsubscribe', async () => {
    const server = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('with-listener');
    });
    const runtimeSession = createSession();
    let webRequestHits = 0;
    runtimeSession.session.webRequest.onCompleted({ urls: [`${server.origin}/*`] }, () => {
      webRequestHits += 1;
    });
    const events: Array<{ phase: string; body: Uint8Array | null }> = [];
    const stop = runtimeSession.observeResponses({}, (event) => events.push(event));
    const page = runtimeSession.createPage();
    try {
      expect(await page.webContents.executeJavaScript(`fetch(${JSON.stringify(`${server.origin}/once`)}).then((response) => response.text())`)).toBe('with-listener');
      const completed = await waitFor(() => events.find((event) => event.phase === 'completed'));
      expect(Buffer.from(bytesOf(completed.body)).toString('utf8')).toBe('with-listener');
      expect(webRequestHits).toBeGreaterThan(0);
      stop();
      events.splice(0, events.length);
      expect(await page.webContents.executeJavaScript(`fetch(${JSON.stringify(`${server.origin}/after`)}).then((response) => response.text())`)).toBe('with-listener');
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(events).toEqual([]);
      runtimeSession.close();
      expect(() => runtimeSession.observeResponses({}, () => {})).toThrow();
    } finally {
      await server.close();
    }
  });

  it('delivers a completed body after the fetch returns, then stops on unsubscribe and close', async () => {
    const server = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('later');
    });
    const runtimeSession = createSession();
    const page = runtimeSession.createPage();
    const events: Array<{ phase: string; body: Uint8Array | null }> = [];
    let stop: Function = () => {};
    const completed = new Promise<Uint8Array>((resolve) => {
      stop = runtimeSession.observeResponses({}, (event) => {
        events.push(event);
        if (event.phase === 'completed' && event.body) resolve(event.body);
      });
    });
    try {
      expect(await page.webContents.executeJavaScript(
        `fetch(${JSON.stringify(`${server.origin}/later`)}).then((response) => response.text())`
      )).toBe('later');
      expect(Buffer.from(bytesOf(await completed)).toString('utf8')).toBe('later');
      stop();
      events.splice(0, events.length);
      expect(await page.webContents.executeJavaScript(
        `fetch(${JSON.stringify(`${server.origin}/after-stop`)}).then((response) => response.text())`
      )).toBe('later');
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(events).toEqual([]);
      runtimeSession.observeResponses({}, () => {
        runtimeSession.close();
      });
      await page.webContents.executeJavaScript(
        `fetch(${JSON.stringify(`${server.origin}/closing`)}).then((response) => response.text())`
      ).catch(() => undefined);
    } finally {
      await server.close();
    }
  });
});

function wsAccept(key: string): string {
  return crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
}

function wsFrame(opcode: number, payload: Buffer, fin = true): Buffer {
  const header = Buffer.alloc(payload.length < 126 ? 2 : 4);
  header[0] = (fin ? 0x80 : 0) | opcode;
  if (payload.length < 126) {
    header[1] = payload.length;
    return Buffer.concat([header, payload]);
  }
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

async function listenWebSocket(onOpen: (socket: Duplex) => void): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer();
  server.on('upgrade', (request, socket) => {
    const key = request.headers['sec-websocket-key'];
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${wsAccept(String(key))}\r\n\r\n`
    );
    onOpen(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('websocket server has no port');
  return {
    url: `ws://127.0.0.1:${address.port}/socket`,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}

function openSocketScript(url: string, replyCount: number): string {
  return `
    new Promise((resolve, reject) => {
      const ws = new WebSocket(${JSON.stringify(url)});
      const seen = [];
      ws.onmessage = (event) => {
        seen.push(typeof event.data === 'string' ? event.data : 'binary');
        if (seen.length === ${replyCount}) {
          ws.close();
          resolve(seen.join(','));
        }
      };
      ws.onerror = () => reject(new Error('socket failed'));
      ws.onopen = () => ws.send('ping');
    })
  `;
}

describe('agentRuntime websocket messages', () => {
  // permessage-deflate is not produced by this fixture. The development page
  // records the pinned-source reading that observed bytes are logical payload.
  // The native forwarder pauses the Mojo message pipe after one unread data
  // frame, so a slow consumer stops upstream metadata instead of dropping it.
  // That pause is source-only and is not exercised here.

  it('rejects an invalid message limit before any socket', () => {
    const runtimeSession = createSession();
    expect(() => runtimeSession.observeWebSockets({ maxBytesPerMessage: 0 }, () => {})).toThrow();
  });

  it('observes text, binary, empty, and fragmented messages in both directions', async () => {
    let replies = 0;
    const server = await listenWebSocket((socket) => {
      socket.on('data', () => {
        if (replies > 0) return;
        replies += 1;
        socket.write(wsFrame(0x1, Buffer.from('hello')));
        socket.write(wsFrame(0x2, Buffer.from([0, 255, 128])));
        socket.write(wsFrame(0x1, Buffer.alloc(0)));
        socket.write(Buffer.concat([
          wsFrame(0x1, Buffer.from('hel'), false),
          wsFrame(0x0, Buffer.from('lo'), true)
        ]));
      });
    });
    const runtimeSession = createSession();
    const events: Array<{ direction: string; opcode: string; body: Uint8Array | null; text: string | null }> = [];
    runtimeSession.observeWebSockets({}, (event) => {
      if (event.phase === 'message') events.push(event);
    });
    const page = runtimeSession.createPage();
    try {
      expect(await page.webContents.executeJavaScript(openSocketScript(server.url, 4))).toBe('hello,binary,,hello');
      const received = events.filter((event) => event.direction === 'received');
      expect(received.map((event) => event.text)).toEqual(['hello', null, '', 'hello']);
      expect(received[1]?.opcode).toBe('binary');
      expect(Array.from(received[1]?.body ?? [])).toEqual([0, 255, 128]);
      expect(received[3]?.body?.byteLength).toBe(5);
      expect(events.some((event) => event.direction === 'sent' && event.text === 'ping')).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('truncates a long capture while the page receives the full message', async () => {
    const payload = 'abcdefghij'.repeat(20);
    const server = await listenWebSocket((socket) => {
      socket.on('data', () => socket.write(wsFrame(0x1, Buffer.from(payload))));
    });
    const runtimeSession = createSession();
    const events: Array<{ truncated: boolean; body: Uint8Array | null; text: string | null }> = [];
    runtimeSession.observeWebSockets({ maxBytesPerMessage: 4 }, (event) => {
      if (event.phase === 'message' && event.direction === 'received') events.push(event);
    });
    const page = runtimeSession.createPage();
    try {
      expect(await page.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const ws = new WebSocket(${JSON.stringify(server.url)});
          ws.onmessage = (event) => resolve(event.data);
          ws.onerror = () => reject(new Error('socket failed'));
          ws.onopen = () => ws.send('x');
        })
      `)).toBe(payload);
      const captured = events[0];
      expect(captured?.truncated).toBe(true);
      expect(captured?.text).toBe(null);
      expect(Buffer.from(bytesOf(captured?.body ?? null)).toString('utf8')).toBe('abcd');
    } finally {
      await server.close();
    }
  });

  it('skips a second connection at the in-flight cap and still forwards it', async () => {
    const server = await listenWebSocket((socket) => {
      socket.on('data', () => socket.write(wsFrame(0x1, Buffer.from('one'))));
    });
    const runtimeSession = createSession();
    const phases: string[] = [];
    runtimeSession.observeWebSockets({ maxInFlight: 1 }, (event) => {
      phases.push(`${event.phase}:${event.skipReason}`);
    });
    const page = runtimeSession.createPage();
    const hold = `
      new Promise((resolve, reject) => {
        const ws = new WebSocket(${JSON.stringify(server.url)});
        ws.onmessage = () => {};
        ws.onerror = () => reject(new Error('socket failed'));
        ws.onopen = () => resolve('open');
      })
    `;
    try {
      expect(await page.webContents.executeJavaScript(hold)).toBe('open');
      expect(await page.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const ws = new WebSocket(${JSON.stringify(server.url)});
          ws.onmessage = (event) => resolve(event.data);
          ws.onerror = () => reject(new Error('socket failed'));
          ws.onopen = () => ws.send('x');
        })
      `)).toBe('one');
      expect(phases.includes('skipped:in-flight-limit')).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('isolates sessions, unsubscribe, and a webRequest listener', async () => {
    const server = await listenWebSocket((socket) => {
      socket.on('data', () => socket.write(wsFrame(0x1, Buffer.from('quiet'))));
    });
    const watched = createSession();
    const other = createSession();
    const plain = createSession();
    const urls: string[] = [];
    const stop = watched.observeWebSockets({}, (event) => {
      if (event.phase === 'message') urls.push(event.url);
    });
    const webRequestHits: string[] = [];
    watched.session.webRequest.onBeforeRequest({ urls: ['ws://127.0.0.1/*'] }, (details, callback) => {
      webRequestHits.push(details.url);
      callback({});
    });
    const script = `
      new Promise((resolve, reject) => {
        const ws = new WebSocket(${JSON.stringify(server.url)});
        ws.onmessage = (event) => resolve(event.data);
        ws.onerror = () => reject(new Error('socket failed'));
        ws.onopen = () => ws.send('x');
      })
    `;
    try {
      expect(await plain.createPage().webContents.executeJavaScript(script)).toBe('quiet');
      expect(await other.createPage().webContents.executeJavaScript(script)).toBe('quiet');
      expect(urls).toEqual([]);
      stop();
      expect(await watched.createPage().webContents.executeJavaScript(script)).toBe('quiet');
      expect(urls).toEqual([]);
      watched.observeWebSockets({}, (event) => {
        if (event.phase === 'message') urls.push(event.url);
      });
      expect(await watched.createPage().webContents.executeJavaScript(script)).toBe('quiet');
      expect(urls.some((url) => url.startsWith('ws://127.0.0.1'))).toBe(true);
      expect(webRequestHits.length).toBeGreaterThan(0);
    } finally {
      await server.close();
    }
  });

  it('reports a failed handshake and a dropped connection', async () => {
    const refused = http.createServer((_request, response) => {
      response.writeHead(400);
      response.end();
    });
    await new Promise<void>((resolve) => refused.listen(0, '127.0.0.1', resolve));
    const refusedAddress = refused.address();
    if (!refusedAddress || typeof refusedAddress === 'string') throw new Error('refused server has no port');
    const refusedUrl = `ws://127.0.0.1:${refusedAddress.port}/nope`;
    const dropped = await listenWebSocket((socket) => {
      socket.destroy();
    });
    const runtimeSession = createSession();
    const phases: string[] = [];
    runtimeSession.observeWebSockets({}, (event) => {
      phases.push(event.phase);
    });
    const page = runtimeSession.createPage();
    try {
      await expect(page.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const ws = new WebSocket(${JSON.stringify(refusedUrl)});
          ws.onopen = () => resolve('open');
          ws.onerror = () => reject(new Error('refused'));
        })
      `)).rejects.toThrow('refused');
      expect(phases.includes('failed')).toBe(true);
      await expect(page.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const ws = new WebSocket(${JSON.stringify(dropped.url)});
          ws.onopen = () => resolve('open');
          ws.onerror = () => reject(new Error('dropped'));
          ws.onclose = () => reject(new Error('dropped'));
        })
      `)).rejects.toThrow('dropped');
      expect(phases.includes('closed') || phases.includes('failed')).toBe(true);
    } finally {
      await dropped.close();
      await new Promise((resolve) => refused.close(resolve));
    }
  });
});

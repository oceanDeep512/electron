import { agentRuntime, BrowserWindow } from 'electron/main';

import { afterEach, describe, expect, it } from 'vitest';

import * as http from 'node:http';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

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
  it('exposes the control plane and does not export native observation', () => {
    expect(agentRuntime.checkpoint.controlPlane).toBe(true);
    expect(agentRuntime.checkpoint.nativePersona).toBe(false);
    expect(agentRuntime.checkpoint.accessibilitySnapshot).toBe(true);
    expect(agentRuntime.checkpoint.responseBodyObservation).toBe(false);
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

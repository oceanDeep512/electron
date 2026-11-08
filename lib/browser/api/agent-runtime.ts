import { app, BrowserWindow, session } from 'electron/main';
import type { Session, WebContents } from 'electron/main';

import {
  AgentRuntimeError,
  CONTENT_SCRIPT,
  ELEMENT_SCRIPT,
  assertClickable,
  assertContentMaxChars,
  assertEditable,
  assertFillText,
  assertMouseButton,
  assertNavigableUrl,
  assertPageSize,
  assertSelector,
  assertTimeoutMs,
  boxCenter,
  buildIsolatedCall,
  checkPartitionReuse,
  checkpoint,
  claimSlot,
  cssPointToWidgetDip,
  decidePersona,
  httpStatusFromNavigateEvent,
  isForeignFailureUrl,
  ownedWebPreferences,
  partitionRecordForReuse,
  planKey,
  readContentResult,
  readElementResult,
  readNavigationStart,
  releaseSlot,
  resolvePartition,
  safeUrlForError,
  shouldArmNavigation,
  validatePersona,
  type AgentErrorCode,
  type ElementBox,
  type NavigationStatus,
  type ResolvedPartition,
  type SlotState
} from '@electron/internal/browser/api/agent-runtime-logic';

type Unsubscribe = () => void;

function listen(emitter: WebContents, event: string, handler: (...args: unknown[]) => void): Unsubscribe {
  const target = emitter as unknown as {
    on: (name: string, listener: (...args: unknown[]) => void) => void;
    removeListener: (name: string, listener: (...args: unknown[]) => void) => void;
  };
  target.on(event, handler);
  return () => {
    target.removeListener(event, handler);
  };
}

function failure(code: AgentErrorCode, message: string): AgentRuntimeError {
  return new AgentRuntimeError(code, message);
}

interface PageApi {
  readonly adopted: boolean;
  readonly webContents: WebContents;
  locator(selector: string): AgentLocator;
  goto(url: string, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<{
    url: string;
    httpStatus: number | null;
    httpStatusText: string;
    httpStatusSource: NavigationStatus['httpStatusSource'];
  }>;
  content(options?: { maxChars?: number; timeoutMs?: number; signal?: AbortSignal }): Promise<{ html: string; truncated: boolean; length: number }>;
  close(): void;
}

interface SessionApi {
  readonly personaApplied: false;
  readonly personaId: null;
  readonly persist: boolean;
  readonly storagePartition: string;
  readonly session: Session;
  readonly isClosed: boolean;
  createPage(options?: { webContents?: WebContents; show?: boolean; width?: number; height?: number }): PageApi;
  close(): void;
}

class AgentPage {
  readonly adopted: boolean;
  private readonly ownedWindow: BrowserWindow | null;
  private handleClosed = false;
  private crashed = false;
  private navigating = false;
  private readonly slots: SlotState = { inflight: 0 };
  private readonly pending = new Set<(code: AgentErrorCode) => void>();
  private readonly unlisten: Unsubscribe[] = [];

  constructor(
    readonly sessionHandle: AgentSession,
    readonly webContents: WebContents,
    ownedWindow: BrowserWindow | null
  ) {
    this.adopted = ownedWindow === null;
    this.ownedWindow = ownedWindow;
    this.unlisten.push(listen(webContents, 'destroyed', () => {
      this.failPending('destroyed');
    }));
    this.unlisten.push(listen(webContents, 'render-process-gone', () => {
      this.crashed = true;
      this.failPending('crashed');
    }));
  }

  locator(selector: string): AgentLocator {
    return new AgentLocator(this, assertSelector(selector));
  }

  async goto(
    url: string,
    options: { timeoutMs?: number; signal?: AbortSignal } = {}
  ): Promise<{ url: string; httpStatus: number | null; httpStatusText: string; httpStatusSource: NavigationStatus['httpStatusSource'] }> {
    const target = assertNavigableUrl(url);
    const timeoutMs = assertTimeoutMs(options.timeoutMs, checkpoint.defaultNavigationTimeoutMs);
    if (this.navigating) {
      throw failure('navigation-in-progress', 'This page already has a navigation in progress');
    }
    // Navigation arms its own timer so a timeout can stop the load.
    return this.operate(options.signal, undefined, async (signal) => {
      this.navigating = true;
      try {
        return await this.navigate(target, timeoutMs, signal);
      } finally {
        this.navigating = false;
      }
    });
  }

  async content(options: { maxChars?: number; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<{ html: string; truncated: boolean; length: number }> {
    const maxChars = assertContentMaxChars(options.maxChars);
    const timeoutMs = assertTimeoutMs(options.timeoutMs, checkpoint.defaultActionTimeoutMs);
    return this.operate(options.signal, timeoutMs, async () => {
      this.assertIdle();
      const raw = await this.eval(buildIsolatedCall(CONTENT_SCRIPT, { maxChars }));
      return readContentResult(raw, maxChars);
    });
  }

  close(): void {
    if (this.handleClosed) return;
    this.handleClosed = true;
    this.failPending('closed');
    for (const unsubscribe of this.unlisten.splice(0)) unsubscribe();
    this.sessionHandle.forget(this);
    if (this.ownedWindow && !this.ownedWindow.isDestroyed()) {
      this.ownedWindow.destroy();
    }
  }

  assertIdle(): void {
    this.assertUsable();
    if (this.navigating) {
      throw failure('navigation-in-progress', 'Wait for the current navigation before using this page');
    }
  }

  async operate<T>(signal: AbortSignal | undefined, timeoutMs: number | undefined, op: (signal: AbortSignal | undefined) => Promise<T>): Promise<T> {
    this.assertUsable();
    if (signal?.aborted) throw failure('aborted', 'The operation was aborted');
    claimSlot(this.slots, checkpoint.maxInFlight);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    let rejectPending: ((code: AgentErrorCode) => void) | undefined;
    try {
      return await new Promise<T>((resolve, reject) => {
        let settled = false;
        const finish = (callback: () => void) => {
          if (settled) return;
          settled = true;
          callback();
        };
        rejectPending = (code) => {
          finish(() => reject(failure(code, `The operation stopped because the page is ${code}`)));
        };
        this.pending.add(rejectPending);
        if (timeoutMs !== undefined) {
          timer = setTimeout(() => {
            finish(() => reject(failure('timeout', `Timed out after ${timeoutMs}ms`)));
          }, timeoutMs);
        }
        if (signal) {
          onAbort = () => finish(() => reject(failure('aborted', 'The operation was aborted')));
          signal.addEventListener('abort', onAbort, { once: true });
        }
        op(signal).then(
          (value) => finish(() => resolve(value)),
          (error: unknown) => finish(() => reject(error))
        );
      });
    } finally {
      if (timer) clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      if (rejectPending) this.pending.delete(rejectPending);
      releaseSlot(this.slots);
    }
  }

  private navigate(
    url: string,
    timeoutMs: number,
    signal: AbortSignal | undefined
  ): Promise<{ url: string; httpStatus: number | null; httpStatusText: string; httpStatusSource: NavigationStatus['httpStatusSource'] }> {
    const contents = this.webContents;
    let status = httpStatusFromNavigateEvent(undefined, undefined);
    let armed = false;
    let committed = false;
    return new Promise((resolve, reject) => {
      let settled = false;
      const subscriptions: Unsubscribe[] = [];
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        for (const unsubscribe of subscriptions) unsubscribe();
        callback();
      };
      const fail = (code: AgentErrorCode, message: string) => finish(() => reject(failure(code, message)));
      let timedOut = false;
      subscriptions.push(listen(contents, 'did-start-navigation', (...args) => {
        const start = readNavigationStart(args);
        if (!start || !shouldArmNavigation(start)) return;
        armed = true;
        status = httpStatusFromNavigateEvent(undefined, undefined);
        committed = false;
      }));
      const rememberStatus = (code: unknown, text: unknown) => {
        if (!armed) return;
        status = httpStatusFromNavigateEvent(code, text);
        committed = true;
      };
      subscriptions.push(listen(contents, 'did-navigate', (_event, _navigated, code, text) => {
        rememberStatus(code, text);
      }));
      subscriptions.push(listen(contents, 'did-frame-navigate', (_event, _navigated, code, text, isMainFrame) => {
        if (isMainFrame === true) rememberStatus(code, text);
      }));
      subscriptions.push(listen(contents, 'did-finish-load', () => {
        if (!armed || !committed) return;
        finish(() => resolve({
          url: contents.isDestroyed() ? url : contents.getURL(),
          httpStatus: status.httpStatus,
          httpStatusText: status.httpStatusText,
          httpStatusSource: status.httpStatusSource
        }));
      }));
      const onFail = (_event: unknown, errorCode: unknown, errorDescription: unknown, validatedURL: unknown, isMainFrame: unknown) => {
        if (isMainFrame === false || !armed || isForeignFailureUrl(validatedURL, url)) return;
        if (timedOut) {
          fail('timeout', `Navigation timed out after ${timeoutMs}ms for ${safeUrlForError(url)}`);
          return;
        }
        if (signal?.aborted) {
          fail('aborted', 'The navigation was aborted');
          return;
        }
        const code = typeof errorCode === 'number' ? errorCode : 0;
        const description = typeof errorDescription === 'string' ? errorDescription : 'navigation failed';
        fail('navigation-failed', `${description} (${code}) for ${safeUrlForError(url)}`);
      };
      subscriptions.push(listen(contents, 'did-fail-load', onFail));
      subscriptions.push(listen(contents, 'did-fail-provisional-load', onFail));
      subscriptions.push(listen(contents, 'destroyed', () => fail('destroyed', 'The page was destroyed during navigation')));
      subscriptions.push(listen(contents, 'render-process-gone', () => fail('crashed', 'The renderer crashed during navigation')));
      if (signal) {
        const onAbort = () => {
          if (!contents.isDestroyed()) contents.stop();
          fail('aborted', 'The navigation was aborted');
        };
        signal.addEventListener('abort', onAbort, { once: true });
        subscriptions.push(() => signal.removeEventListener('abort', onAbort));
      }
      const timer = setTimeout(() => {
        timedOut = true;
        if (!contents.isDestroyed()) contents.stop();
        fail('timeout', `Navigation timed out after ${timeoutMs}ms for ${safeUrlForError(url)}`);
      }, timeoutMs);
      subscriptions.push(() => clearTimeout(timer));
      try {
        // The returned promise is not an HTTP status. Status comes only from
        // did-navigate after this call's main-frame navigation has started.
        contents.loadURL(url).catch(() => undefined);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fail('navigation-failed', message);
      }
    });
  }

  async probe(selector: string, action: 'probe' | 'focus-editable' | 'value', scroll: boolean): Promise<unknown> {
    this.assertUsable();
    return this.eval(buildIsolatedCall(ELEMENT_SCRIPT, { selector, action, scroll }));
  }

  clickAt(box: ElementBox, button: 'left' | 'middle' | 'right'): void {
    assertClickable(box);
    const center = boxCenter(box);
    const point = cssPointToWidgetDip(center.x, center.y, this.webContents.zoomFactor);
    this.focusForInput();
    this.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y, button });
    this.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button, clickCount: 1 });
    this.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button, clickCount: 1 });
  }

  insert(text: string): void {
    this.focusForInput();
    this.webContents.insertText(text);
  }

  pressKey(key: string): void {
    const planned = planKey(key);
    this.focusForInput();
    this.webContents.sendInputEvent({ type: 'keyDown', keyCode: planned.keyCode });
    if (planned.includeChar) {
      this.webContents.sendInputEvent({ type: 'char', keyCode: planned.keyCode });
    }
    this.webContents.sendInputEvent({ type: 'keyUp', keyCode: planned.keyCode });
  }

  private async eval(code: string): Promise<unknown> {
    this.assertUsable();
    try {
      return await this.webContents.executeJavaScriptInIsolatedWorld(
        checkpoint.isolatedWorldId,
        [{ code }]
      );
    } catch (error) {
      if (this.webContents.isDestroyed()) throw failure('destroyed', 'The page was destroyed');
      if (this.crashed || this.webContents.isCrashed()) throw failure('crashed', 'The renderer crashed');
      const message = error instanceof Error ? error.message : String(error);
      throw failure('page-script-failed', message);
    }
  }

  private focusForInput(): void {
    const owner = BrowserWindow.fromWebContents(this.webContents);
    if (owner && !owner.isDestroyed()) owner.focus();
    if (!this.webContents.isDestroyed()) this.webContents.focus();
  }

  private assertUsable(): void {
    if (this.webContents.isDestroyed()) {
      throw failure('destroyed', 'The page has been destroyed');
    }
    if (this.handleClosed) throw failure('closed', 'The page handle has been closed');
    if (this.crashed || this.webContents.isCrashed()) {
      throw failure('crashed', 'The renderer has crashed');
    }
  }

  private failPending(code: AgentErrorCode): void {
    for (const reject of this.pending) reject(code);
    this.pending.clear();
  }
}

class AgentLocator {
  constructor(
    private readonly page: AgentPage,
    private readonly selector: string
  ) {}

  boundingBox(options: { timeoutMs?: number; signal?: AbortSignal; scroll?: boolean } = {}): Promise<ElementBox> {
    return this.pageAction(options, async () => {
      const result = readElementResult(await this.page.probe(this.selector, 'probe', options.scroll !== false));
      if (!result.ok) throw failure(result.reason, result.message);
      if (!('box' in result)) throw failure('page-script-failed', 'Expected an element box');
      return result.box;
    });
  }

  click(options: { timeoutMs?: number; signal?: AbortSignal; button?: 'left' | 'middle' | 'right'; scroll?: boolean } = {}): Promise<void> {
    const button = assertMouseButton(options.button);
    return this.pageAction(options, async () => {
      const result = readElementResult(await this.page.probe(this.selector, 'probe', options.scroll !== false));
      if (!result.ok) throw failure(result.reason, result.message);
      if (!('box' in result)) throw failure('page-script-failed', 'Expected an element box');
      this.page.clickAt(result.box, button);
    });
  }

  fill(text: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<void> {
    const value = assertFillText(text);
    return this.pageAction(options, async () => {
      const result = readElementResult(await this.page.probe(this.selector, 'focus-editable', true));
      if (!result.ok) throw failure(result.reason, result.message);
      if (!('box' in result)) throw failure('page-script-failed', 'Expected an element box');
      assertEditable(result.box);
      this.page.insert(value);
    });
  }

  press(key: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<void> {
    planKey(key);
    return this.pageAction(options, async () => {
      const result = readElementResult(await this.page.probe(this.selector, 'focus-editable', true));
      if (!result.ok) throw failure(result.reason, result.message);
      if (!('box' in result)) throw failure('page-script-failed', 'Expected an element box');
      assertEditable(result.box);
      this.page.pressKey(key);
    });
  }

  inputValue(options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<string> {
    return this.pageAction(options, async () => {
      const result = readElementResult(await this.page.probe(this.selector, 'value', false));
      if (!result.ok) throw failure(result.reason, result.message);
      if (!('value' in result)) throw failure('page-script-failed', 'Expected an input value');
      return result.value;
    });
  }

  private pageAction<T>(
    options: { timeoutMs?: number; signal?: AbortSignal },
    op: () => Promise<T>
  ): Promise<T> {
    const timeoutMs = assertTimeoutMs(options.timeoutMs, checkpoint.defaultActionTimeoutMs);
    return this.page.operate(options.signal, timeoutMs, async () => {
      this.page.assertIdle();
      return op();
    });
  }
}

function publishPage(page: AgentPage): PageApi {
  return {
    adopted: page.adopted,
    get webContents() {
      return page.webContents;
    },
    locator: (selector) => page.locator(selector),
    goto: (url, options) => page.goto(url, options),
    content: (options) => page.content(options),
    close: () => page.close()
  };
}

class AgentSession {
  readonly personaApplied = false as const;
  readonly personaId = null;
  readonly api: SessionApi;
  private readonly pages = new Set<AgentPage>();
  private closed = false;

  constructor(
    readonly partition: ResolvedPartition,
    readonly session: Session
  ) {
    const self = this;
    this.api = {
      personaApplied: this.personaApplied,
      personaId: this.personaId,
      get persist() {
        return self.persist;
      },
      get storagePartition() {
        return self.storagePartition;
      },
      get session() {
        return self.session;
      },
      get isClosed() {
        return self.isClosed;
      },
      createPage: (options) => publishPage(self.createPage(options)),
      close: () => self.close()
    };
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get persist(): boolean {
    return this.partition.persist;
  }

  get storagePartition(): string {
    return this.partition.storagePartition;
  }

  createPage(options: {
    webContents?: WebContents;
    show?: boolean;
    width?: number;
    height?: number;
  } = {}): AgentPage {
    if (this.closed) throw failure('closed', 'The session has been closed');
    if (options.webContents) {
      if (options.show !== undefined || options.width !== undefined || options.height !== undefined) {
        throw failure('invalid-size', 'show, width, and height apply only when agentRuntime creates the window');
      }
      if (options.webContents.isDestroyed()) throw failure('destroyed', 'The WebContents has been destroyed');
      if (options.webContents.session !== this.session) {
        throw failure(
          'partition-mismatch',
          `The WebContents session is not ${this.storagePartition}. Existing webPreferences were left unchanged.`
        );
      }
      const page = new AgentPage(this, options.webContents, null);
      this.pages.add(page);
      return page;
    }
    const size = assertPageSize(options.width, options.height);
    const win = new BrowserWindow({
      show: options.show ?? false,
      width: size.width,
      height: size.height,
      webPreferences: ownedWebPreferences(this.storagePartition)
    });
    try {
      const page = new AgentPage(this, win.webContents, win);
      this.pages.add(page);
      return page;
    } catch (error) {
      if (!win.isDestroyed()) win.destroy();
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const page of [...this.pages]) page.close();
    sessions.delete(this.storagePartition);
  }

  forget(page: AgentPage): void {
    this.pages.delete(page);
  }
}

const sessions = new Map<string, AgentSession>();
// Native stage writes this before the first renderer for that partition starts.
// close() must not delete entries. This checkpoint never writes the map.
const appliedPersonaIds = new Map<string, string>();

function createSession(options: { partition: unknown; persist?: unknown; persona?: unknown }): SessionApi {
  const decision = decidePersona(options.persona);
  if (decision.action === 'invalid') {
    throw failure('invalid-persona', decision.errors.join('; '));
  }
  if (decision.action === 'unavailable') {
    throw failure(
      'native-persona-unavailable',
      'Native fingerprint persona is not implemented. validatePersona() only checks the config and does not change the renderer, network stack, or any page. Omit persona until that stage is wired.'
    );
  }
  const resolved = resolvePartition(options);
  const existing = sessions.get(resolved.storagePartition);
  const reuse = checkPartitionReuse(
    partitionRecordForReuse(
      existing && !existing.isClosed
        ? { persist: existing.persist, personaApplied: existing.personaApplied, personaId: existing.personaId }
        : undefined,
      appliedPersonaIds.get(resolved.storagePartition),
      resolved.persist
    ),
    { ...resolved, personaId: null }
  );
  if (reuse === 'reuse' && existing) return existing.api;
  if (!app.isReady()) {
    throw failure('app-not-ready', 'createSession requires the app ready event');
  }
  const electronSession = session.fromPartition(resolved.storagePartition);
  const created = new AgentSession(resolved, electronSession);
  sessions.set(resolved.storagePartition, created);
  return created.api;
}

const agentRuntime = {
  checkpoint,
  createSession,
  resolvePartition,
  validatePersona,
  AgentRuntimeError
};

export default agentRuntime;

import { app, BrowserWindow, session } from 'electron/main';
import type { Session, WebContents } from 'electron/main';

import {
  AgentRuntimeError,
  CONTENT_SCRIPT,
  ELEMENT_SCRIPT,
  applyNavigationEvent,
  applyResponseObservation,
  assembleAXSnapshot,
  assertClickable,
  assertContentMaxChars,
  assertEditable,
  assertFillText,
  assertMouseButton,
  assertNavigableUrl,
  assertPageSize,
  assertSelector,
  assertSnapshotOptions,
  assertTimeoutMs,
  boxCenter,
  buildIsolatedCall,
  checkPartitionReuse,
  checkpoint,
  claimSlot,
  createEffectGate,
  createListenerSet,
  createNavigation,
  createResponseObservationBudget,
  cssPointToWidgetDip,
  decidePersona,
  hostEffectAllowed,
  normalizeResponseObservation,
  ownedWebPreferences,
  performHostEffect,
  planKey,
  readContentResult,
  readElementResult,
  readLoadRejection,
  readNavigationStart,
  releaseSlot,
  resolvePartition,
  settleEffectGate,
  unionResponseObservationPolicies,
  validatePersona,
  type AgentErrorCode,
  type AXSnapshot,
  type ResponseObservationBudget,
  type ResponseObservationEvent,
  type ResponseObservationPolicy,
  type EffectGate,
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
  snapshot(options?: {
    maxNodes?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    framePolicy?: 'all' | 'same-origin';
  }): Promise<AXSnapshot>;
  close(): void;
}

interface NativeResponseEvent {
  requestId: string;
  phase: string;
  url: string;
  redirectUrl: string;
  status: number;
  mimeType: string;
  networkDecoded: boolean;
  truncated: boolean;
  skipReason: string;
  errorCode: number;
  body: Uint8Array | null;
}

interface NativeResponseSession {
  setResponseBodyObservation(
    listener: ((event: NativeResponseEvent) => void) | null,
    options?: ResponseObservationPolicy
  ): void;
}

interface ResponseSubscriber {
  policy: ResponseObservationPolicy;
  budget: ResponseObservationBudget;
  listener: (event: ResponseObservationEvent) => void;
}

interface SessionApi {
  readonly personaApplied: false;
  readonly personaId: null;
  readonly persist: boolean;
  readonly storagePartition: string;
  readonly session: Session;
  readonly isClosed: boolean;
  createPage(options?: { webContents?: WebContents; show?: boolean; width?: number; height?: number }): PageApi;
  observeResponses(
    options: {
      urls?: string[];
      maxBytesPerResponse?: number;
      maxInFlight?: number;
      maxAggregateBytes?: number;
    } | undefined,
    listener: (event: ResponseObservationEvent) => void
  ): () => void;
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
    // The outer operation timeout is omitted so it does not stop the load twice.
    return this.operate(options.signal, undefined, async () => {
      this.navigating = true;
      try {
        return await this.navigate(target, timeoutMs, options.signal);
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

  async snapshot(options: {
    maxNodes?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    framePolicy?: 'all' | 'same-origin';
  } = {}): Promise<AXSnapshot> {
    const request = assertSnapshotOptions(options);
    return this.operate(options.signal, request.timeoutMs, async (gate) => {
      const raw: unknown = await this.webContents.captureAccessibilitySnapshot({
        maxNodes: request.maxNodes,
        timeoutMs: request.timeoutMs,
        framePolicy: request.framePolicy
      });
      // A timeout or abort settles the gate before this continuation. Do not
      // hand the caller a tree after that rejection.
      if (!hostEffectAllowed(gate)) {
        throw failure('aborted', 'The accessibility snapshot was discarded after the operation settled');
      }
      return assembleAXSnapshot(raw);
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

  async operate<T>(signal: AbortSignal | undefined, timeoutMs: number | undefined, op: (gate: EffectGate) => Promise<T>): Promise<T> {
    this.assertUsable();
    if (signal?.aborted) throw failure('aborted', 'The operation was aborted');
    claimSlot(this.slots, checkpoint.maxInFlight);
    const gate = createEffectGate();
    const listeners = createListenerSet();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectPending: ((code: AgentErrorCode) => void) | undefined;
    try {
      return await new Promise<T>((resolve, reject) => {
        let settled = false;
        const finish = (callback: () => void) => {
          if (settled) return;
          settled = true;
          // Settle before the page script's continuation can send input.
          settleEffectGate(gate);
          if (timer) clearTimeout(timer);
          listeners.close();
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
          const onAbort = () => finish(() => reject(failure('aborted', 'The operation was aborted')));
          signal.addEventListener('abort', onAbort, { once: true });
          listeners.add(() => signal.removeEventListener('abort', onAbort));
        }
        op(gate).then(
          (value) => finish(() => resolve(value)),
          (error: unknown) => finish(() => reject(error))
        );
      });
    } finally {
      // The script cannot be cancelled. Releasing the slot here lets the next
      // operation run. Host effects stay closed because the gate is settled.
      settleEffectGate(gate);
      if (timer) clearTimeout(timer);
      listeners.close();
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
    return new Promise((resolve, reject) => {
      let state = createNavigation(url);
      const listeners = createListenerSet();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let published = false;
      const emit = (event: Parameters<typeof applyNavigationEvent>[1]) => {
        if (published) return;
        state = applyNavigationEvent(state, event);
        if (!state.outcome) return;
        published = true;
        if (timer) clearTimeout(timer);
        listeners.close();
        const outcome = state.outcome;
        if (outcome.type === 'success') {
          resolve({
            url: outcome.url,
            httpStatus: outcome.status.httpStatus,
            httpStatusText: outcome.status.httpStatusText,
            httpStatusSource: outcome.status.httpStatusSource
          });
          return;
        }
        reject(failure(outcome.code, outcome.message));
      };
      listeners.add(listen(contents, 'did-start-navigation', (...args) => {
        const start = readNavigationStart(args);
        if (!start) return;
        emit({ type: 'start', ...start });
      }));
      listeners.add(listen(contents, 'did-navigate', (_event, navigated, code, text) => {
        emit({
          type: 'commit',
          url: typeof navigated === 'string' ? navigated : '',
          httpResponseCode: code,
          httpStatusText: text
        });
      }));
      listeners.add(listen(contents, 'did-frame-navigate', (_event, navigated, code, text, isMainFrame) => {
        if (isMainFrame !== true) return;
        emit({
          type: 'commit',
          url: typeof navigated === 'string' ? navigated : '',
          httpResponseCode: code,
          httpStatusText: text
        });
      }));
      listeners.add(listen(contents, 'did-finish-load', () => {
        emit({ type: 'finish-load', url: contents.isDestroyed() ? url : contents.getURL() });
      }));
      const onFail = (_event: unknown, errorCode: unknown, errorDescription: unknown, validatedURL: unknown, isMainFrame: unknown) => {
        emit({ type: 'fail', errorCode, errorDescription, validatedURL, isMainFrame });
      };
      listeners.add(listen(contents, 'did-fail-load', onFail));
      listeners.add(listen(contents, 'did-fail-provisional-load', onFail));
      listeners.add(listen(contents, 'destroyed', () => emit({ type: 'destroyed' })));
      listeners.add(listen(contents, 'render-process-gone', () => emit({ type: 'crashed' })));
      if (signal) {
        const onAbort = () => {
          emit({ type: 'abort' });
          if (!contents.isDestroyed()) contents.stop();
        };
        signal.addEventListener('abort', onAbort, { once: true });
        listeners.add(() => signal.removeEventListener('abort', onAbort));
      }
      timer = setTimeout(() => {
        emit({ type: 'timeout', timeoutMs });
        if (!contents.isDestroyed()) contents.stop();
      }, timeoutMs);
      // Resolving this promise is not success and is not an HTTP status.
      // A rejection other than ERR_ABORTED is a known failure. ERR_ABORTED
      // can be the about:blank race and is ignored by the reducer.
      contents.loadURL(url).then(
        () => undefined,
        (error: unknown) => {
          const rejected = readLoadRejection(error);
          emit({ type: 'load-rejected', errno: rejected.errno, message: rejected.message });
        }
      );
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
    return this.pageAction(options, async (gate) => {
      const result = readElementResult(await this.page.probe(this.selector, 'probe', options.scroll !== false));
      if (!result.ok) throw failure(result.reason, result.message);
      if (!('box' in result)) throw failure('page-script-failed', 'Expected an element box');
      performHostEffect(gate, () => {
        this.page.clickAt(result.box, button);
      });
    });
  }

  fill(text: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<void> {
    const value = assertFillText(text);
    return this.pageAction(options, async (gate) => {
      const result = readElementResult(await this.page.probe(this.selector, 'focus-editable', true));
      if (!result.ok) throw failure(result.reason, result.message);
      if (!('box' in result)) throw failure('page-script-failed', 'Expected an element box');
      performHostEffect(gate, () => {
        assertEditable(result.box);
        this.page.insert(value);
      });
    });
  }

  press(key: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<void> {
    planKey(key);
    return this.pageAction(options, async (gate) => {
      const result = readElementResult(await this.page.probe(this.selector, 'focus-editable', true));
      if (!result.ok) throw failure(result.reason, result.message);
      if (!('box' in result)) throw failure('page-script-failed', 'Expected an element box');
      performHostEffect(gate, () => {
        assertEditable(result.box);
        this.page.pressKey(key);
      });
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
    op: (gate: EffectGate) => Promise<T>
  ): Promise<T> {
    const timeoutMs = assertTimeoutMs(options.timeoutMs, checkpoint.defaultActionTimeoutMs);
    return this.page.operate(options.signal, timeoutMs, async (gate) => {
      this.page.assertIdle();
      return op(gate);
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
    snapshot: (options) => page.snapshot(options),
    close: () => page.close()
  };
}

function asResponseEvent(event: NativeResponseEvent): ResponseObservationEvent | null {
  if (
    event.phase !== 'opened' &&
    event.phase !== 'redirect' &&
    event.phase !== 'completed' &&
    event.phase !== 'aborted' &&
    event.phase !== 'skipped'
  ) {
    return null;
  }
  const skipReason = event.skipReason === 'in-flight-limit' ||
    event.skipReason === 'aggregate-limit' ||
    event.skipReason === 'tee-failed'
    ? event.skipReason
    : '';
  return {
    requestId: event.requestId,
    phase: event.phase,
    url: event.url,
    redirectUrl: event.redirectUrl,
    status: event.status,
    mimeType: event.mimeType,
    networkDecoded: event.networkDecoded,
    truncated: event.truncated,
    skipReason,
    errorCode: event.errorCode,
    body: event.body
  };
}

class AgentSession {
  readonly personaApplied = false as const;
  readonly personaId = null;
  readonly api: SessionApi;
  private readonly pages = new Set<AgentPage>();
  private readonly responseSubscribers = new Set<ResponseSubscriber>();
  private responseNativeInstalled = false;
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
      observeResponses: (options, listener) => self.observeResponses(options, listener),
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

  observeResponses(
    options: {
      urls?: string[];
      maxBytesPerResponse?: number;
      maxInFlight?: number;
      maxAggregateBytes?: number;
    } | undefined,
    listener: (event: ResponseObservationEvent) => void
  ): () => void {
    if (this.closed) throw failure('closed', 'The session has been closed');
    if (typeof listener !== 'function') {
      throw failure('invalid-response-observation', 'listener must be a function');
    }
    const policy = normalizeResponseObservation(options);
    const subscriber: ResponseSubscriber = {
      policy,
      budget: createResponseObservationBudget(),
      listener
    };
    this.responseSubscribers.add(subscriber);
    this.pushResponseObservation();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.responseSubscribers.delete(subscriber);
      if (!this.closed) this.pushResponseObservation();
    };
  }

  private pushResponseObservation(): void {
    const native = this.session as Session & NativeResponseSession;
    if (this.responseSubscribers.size === 0) {
      if (this.responseNativeInstalled) {
        native.setResponseBodyObservation(null);
        this.responseNativeInstalled = false;
      }
      return;
    }
    const policy = unionResponseObservationPolicies(
      [...this.responseSubscribers].map((subscriber) => subscriber.policy)
    );
    native.setResponseBodyObservation((event) => {
      this.dispatchResponseObservation(event);
    }, policy);
    this.responseNativeInstalled = true;
  }

  private dispatchResponseObservation(raw: NativeResponseEvent): void {
    const event = asResponseEvent(raw);
    if (!event) return;
    for (const subscriber of [...this.responseSubscribers]) {
      const presented = applyResponseObservation(subscriber.policy, subscriber.budget, event);
      if (!presented) continue;
      try {
        subscriber.listener(presented);
      } catch {
        // A listener exception can include the response. Do not log the event.
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.responseSubscribers.clear();
    if (this.responseNativeInstalled) {
      (this.session as Session & NativeResponseSession).setResponseBodyObservation(null);
      this.responseNativeInstalled = false;
    }
    for (const page of [...this.pages]) page.close();
    sessions.delete(this.storagePartition);
  }

  forget(page: AgentPage): void {
    this.pages.delete(page);
  }
}

const sessions = new Map<string, AgentSession>();

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
    existing && !existing.isClosed
      ? { persist: existing.persist, personaApplied: existing.personaApplied, personaId: existing.personaId }
      : undefined,
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

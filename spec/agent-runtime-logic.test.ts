import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

import {
  AgentRuntimeError,
  CONTENT_SCRIPT,
  ELEMENT_SCRIPT,
  NET_ERR_ABORTED,
  applyNavigationEvent,
  assembleAXSnapshot,
  assertClickable,
  assertFillText,
  assertNavigableUrl,
  assertSnapshotOptions,
  boxCenter,
  buildIsolatedCall,
  checkPartitionReuse,
  checkpoint,
  claimSlot,
  createEffectGate,
  createListenerSet,
  createNavigation,
  cssPointToWidgetDip,
  decidePersona,
  httpStatusFromNavigateEvent,
  isForeignFailureUrl,
  ownedWebPreferences,
  performHostEffect,
  personaStorageId,
  planKey,
  readContentResult,
  readElementResult,
  readLoadRejection,
  readNavigationStart,
  releaseSlot,
  resolvePartition,
  safeUrlForError,
  settleEffectGate,
  applyResponseObservation,
  applyWebSocketObservation,
  createResponseObservationBudget,
  createWebSocketObservationBudget,
  normalizeResponseObservation,
  normalizeWebSocketObservation,
  responseUrlMatches,
  shouldArmNavigation,
  unionResponseObservationPolicies,
  unionWebSocketObservationPolicies,
  websocketUrlMatches,
  WEBSOCKET_DEFAULT_MAX_BYTES,
  validatePersona,
  RESPONSE_DEFAULT_AGGREGATE_BYTES,
  RESPONSE_DEFAULT_MAX_BYTES,
  RESPONSE_DEFAULT_MAX_IN_FLIGHT,
  RESPONSE_MAX_AGGREGATE_BYTES,
  RESPONSE_MAX_BYTES,
  RESPONSE_MAX_IN_FLIGHT,
  type NavigationEvent,
  type Persona,
  type ResponseObservationEvent,
  type WebSocketObservationEvent
} from '../lib/browser/api/agent-runtime-logic.ts';

function runPageScript(code: string, names: string[], values: unknown[]): unknown {
  return vm.compileFunction(`return ${code}`, names)(...values);
}

function validPersona(extra: Record<string, unknown> = {}): Record<string, unknown> {
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
    acceptLanguages: ['zh-CN', 'en'],
    timezone: 'Asia/Shanghai',
    hardwareConcurrency: 8,
    deviceMemory: 8,
    screen: {
      width: 1920,
      height: 1080,
      availWidth: 1920,
      availHeight: 1040,
      colorDepth: 24,
      deviceScaleFactor: 1
    },
    webgl: { vendor: 'Example', renderer: 'Example Renderer' },
    webgpu: { vendor: 'Example', architecture: 'generic', device: 'device', description: 'description' },
    webrtcIpHandlingPolicy: 'default_public_interface_only',
    fontPolicy: 'real',
    ...extra
  };
}

test('checkpoint records the pinned baseline and per-surface persona flags', () => {
  assert.equal(checkpoint.baseline, 'ef2710fa6c10fe56365a9949fa783d26ca1499e5');
  assert.equal(checkpoint.chromium, '159.0.8140.0');
  assert.equal(checkpoint.controlPlane, true);
  assert.equal(checkpoint.nativePersona.userAgent, true);
  assert.equal(checkpoint.nativePersona.clientHints, true);
  assert.equal(checkpoint.nativePersona.acceptLanguages, true);
  assert.equal(checkpoint.nativePersona.timezone, true);
  assert.equal(checkpoint.nativePersona.hardwareConcurrency, true);
  assert.equal(checkpoint.nativePersona.deviceMemory, true);
  assert.equal(checkpoint.nativePersona.screen, true);
  assert.equal(checkpoint.nativePersona.webgl, true);
  assert.equal(checkpoint.nativePersona.webgpu, true);
  assert.equal(checkpoint.nativePersona.canvas, true);
  assert.equal(checkpoint.nativePersona.audio, true);
  assert.equal(checkpoint.nativePersona.webrtc, true);
  assert.equal(checkpoint.nativePersona.fonts, false);
  assert.equal(checkpoint.accessibilitySnapshot, true);
  assert.equal(checkpoint.responseBodyObservation, true);
  assert.equal(checkpoint.webSocketMessageObservation, true);
  assert.equal(checkpoint.isolatedWorldId, 1001);
  assert.notEqual(checkpoint.isolatedWorldId, 0);
  assert.notEqual(checkpoint.isolatedWorldId, 999);
});

test('partition names never select the default session and reject conflicts', () => {
  assert.throws(() => resolvePartition({ partition: '' }), (error: unknown) => {
    return error instanceof AgentRuntimeError && error.code === 'invalid-partition';
  });
  assert.throws(() => resolvePartition({ partition: 'persist:persist:name' }), (error: unknown) => {
    return error instanceof AgentRuntimeError && error.code === 'invalid-partition';
  });
  assert.throws(() => resolvePartition({ partition: '../secret' }), (error: unknown) => {
    return error instanceof AgentRuntimeError && error.code === 'invalid-partition';
  });
  assert.deepEqual(resolvePartition({ partition: 'persist:alpha' }), {
    storagePartition: 'persist:alpha',
    persist: true,
    name: 'alpha'
  });
  assert.deepEqual(resolvePartition({ partition: 'alpha', persist: true }), {
    storagePartition: 'persist:alpha',
    persist: true,
    name: 'alpha'
  });
  assert.deepEqual(resolvePartition({ partition: 'alpha', persist: false }), {
    storagePartition: 'alpha',
    persist: false,
    name: 'alpha'
  });
  assert.throws(() => resolvePartition({ partition: 'persist:alpha', persist: false }), (error: unknown) => {
    return error instanceof AgentRuntimeError && error.code === 'partition-conflict';
  });
});

test('an open partition is not reused with a different persona or persistence', () => {
  const memory = { ...resolvePartition({ partition: 'alpha' }), personaId: null };
  assert.equal(checkPartitionReuse(undefined, memory), 'create');
  assert.equal(
    checkPartitionReuse({ persist: false, personaApplied: false, personaId: null }, memory),
    'reuse'
  );
  assert.throws(
    () => checkPartitionReuse({ persist: true, personaApplied: false, personaId: null }, memory),
    (error: unknown) => error instanceof AgentRuntimeError && error.code === 'partition-conflict'
  );
  assert.throws(
    () => checkPartitionReuse({ persist: false, personaApplied: true, personaId: 'other' }, memory),
    (error: unknown) => error instanceof AgentRuntimeError && error.code === 'partition-conflict'
  );
  assert.throws(
    () => checkPartitionReuse({ persist: false, personaApplied: true, personaId: null }, memory),
    (error: unknown) => error instanceof AgentRuntimeError && error.code === 'partition-conflict'
  );
});

test('implemented persona surfaces apply and the rest are refused', () => {
  assert.deepEqual(decidePersona(undefined), { action: 'omit' });
  const missing = decidePersona(null);
  assert.equal(missing.action, 'invalid');
  const invalid = decidePersona({ seed: 'only' });
  assert.equal(invalid.action, 'invalid');
  const codec = validatePersona(validPersona({ codecs: { audio: 'aac' } }));
  assert.equal(codec.ok, false);
  const emptyVersion = validatePersona(validPersona({
    userAgentMetadata: {
      ...(validPersona().userAgentMetadata as Record<string, unknown>),
      fullVersion: ''
    }
  }));
  assert.equal(emptyVersion.ok, false);
  const fontCore = decidePersona(validPersona({ fontPolicy: 'core', screen: undefined, webgl: undefined, webgpu: undefined, webrtcIpHandlingPolicy: 'default' }));
  assert.equal(fontCore.action, 'invalid');
  if (fontCore.action === 'invalid') {
    assert.equal(fontCore.errors.some((error) => error.includes("fontPolicy 'core'")), true);
  }
  const validated = validatePersona(validPersona());
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  const decision = decidePersona(validPersona());
  assert.equal(decision.action, 'apply');
  if (decision.action !== 'apply') return;
  assert.equal(decision.persona.screen?.width, 1920);
  assert.equal(decision.persona.webgl?.vendor, 'Example');
  assert.equal(decision.persona.webgpu?.description, 'description');
  assert.equal(decision.persona.webrtcIpHandlingPolicy, 'default_public_interface_only');
  assert.equal(decision.persona.userAgentMetadata.model, '');
  assert.equal(personaStorageId(decision.persona), personaStorageId(validated.persona));
  const again = JSON.parse(personaStorageId(decision.persona)) as Persona;
  assert.equal(personaStorageId(again), personaStorageId(decision.persona));

  const minimal = validPersona({
    screen: undefined,
    webgl: undefined,
    webgpu: undefined,
    webrtcIpHandlingPolicy: 'default'
  });
  delete minimal.screen;
  delete minimal.webgl;
  delete minimal.webgpu;
  const applied = decidePersona(minimal);
  assert.equal(applied.action, 'apply');
  if (applied.action !== 'apply') return;
  assert.equal(applied.persona.screen, undefined);
  assert.equal(applied.persona.fontPolicy, 'real');
  assert.equal(applied.persona.webrtcIpHandlingPolicy, 'default');
});

test('http status is taken only from a real did-navigate code', () => {
  assert.deepEqual(httpStatusFromNavigateEvent(undefined, undefined), {
    httpStatus: null,
    httpStatusText: '',
    httpStatusSource: 'unavailable'
  });
  assert.equal(httpStatusFromNavigateEvent(-1, '').httpStatus, null);
  assert.equal(httpStatusFromNavigateEvent(99, 'nope').httpStatus, null);
  assert.equal(httpStatusFromNavigateEvent(600, 'nope').httpStatus, null);
  assert.equal(httpStatusFromNavigateEvent('200', 'OK').httpStatus, null);
  assert.deepEqual(httpStatusFromNavigateEvent(404, 'Not Found'), {
    httpStatus: 404,
    httpStatusText: 'Not Found',
    httpStatusSource: 'did-navigate'
  });
  assert.equal(httpStatusFromNavigateEvent(201, 201).httpStatusText, '');
});

test('navigation arming ignores the initial about:blank document', () => {
  const start = readNavigationStart([{
    url: 'about:blank',
    isMainFrame: true,
    isSameDocument: false
  }]);
  assert.ok(start);
  assert.equal(shouldArmNavigation(start), false);
  const real = readNavigationStart([{
    url: 'https://example.test/',
    isMainFrame: true,
    isSameDocument: false
  }]);
  assert.ok(real);
  assert.equal(shouldArmNavigation(real), true);
  assert.equal(shouldArmNavigation({ ...real, isMainFrame: false }), false);
  assert.equal(shouldArmNavigation({ ...real, isSameDocument: true }), false);
  assert.equal(readNavigationStart(['https://example.test/']), null);
  assert.equal(isForeignFailureUrl('about:blank', 'https://example.test/'), true);
  assert.equal(isForeignFailureUrl('https://example.test/', 'https://example.test/'), false);
});

test('in-flight operations are bounded and slots are released', () => {
  const state = { inflight: 0 };
  claimSlot(state, 2);
  claimSlot(state, 2);
  assert.throws(() => claimSlot(state, 2), (error: unknown) => {
    return error instanceof AgentRuntimeError && error.code === 'busy';
  });
  releaseSlot(state);
  claimSlot(state, 2);
  assert.equal(state.inflight, 2);
});

test('selectors and page arguments are passed as JSON, not interpolated source', () => {
  const selector = '"); globalThis.__agentPwned = true; //';
  const code = buildIsolatedCall(ELEMENT_SCRIPT, { selector, action: 'probe', scroll: false });
  assert.equal(code.includes('globalThis.__agentPwned = true; //'), true);
  const seen: string[] = [];
  const result = runPageScript(code, ['document', 'getComputedStyle'], [{
    querySelector(value: string) {
      seen.push(value);
      return null;
    }
  }, () => {
    throw new Error('style should not be read when the element is missing');
  }]);
  assert.deepEqual(seen, [selector]);
  assert.equal((globalThis as { __agentPwned?: boolean }).__agentPwned, undefined);
  assert.deepEqual(readElementResult(result), { ok: false, reason: 'not-found', message: 'not-found' });
});

test('the element script reports visibility without overlay hit testing', () => {
  const code = buildIsolatedCall(ELEMENT_SCRIPT, { selector: '#go', action: 'probe', scroll: true });
  let scrolled = false;
  const box = readElementResult(runPageScript(code, ['document', 'getComputedStyle'], [{
    querySelector() {
      return {
        tagName: 'BUTTON',
        disabled: false,
        isContentEditable: false,
        scrollIntoView() {
          scrolled = true;
        },
        getBoundingClientRect() {
          return { x: 10, y: 20, width: 30, height: 40 };
        }
      };
    }
  }, () => ({ display: 'block', visibility: 'visible', opacity: '1' })]));
  assert.equal(scrolled, true);
  assert.equal(box.ok, true);
  if (!box.ok || !('box' in box)) return;
  assert.deepEqual(box.box, {
    x: 10,
    y: 20,
    width: 30,
    height: 40,
    visible: true,
    disabled: false,
    editable: false
  });
  assert.doesNotThrow(() => assertClickable(box.box));

  const hidden = readElementResult(runPageScript(code, ['document', 'getComputedStyle'], [{
    querySelector() {
      return {
        tagName: 'BUTTON',
        disabled: false,
        isContentEditable: false,
        scrollIntoView() {},
        getBoundingClientRect() {
          return { x: 0, y: 0, width: 10, height: 10 };
        }
      };
    }
  }, () => ({ display: 'none', visibility: 'visible', opacity: '1' })]));
  assert.equal(hidden.ok, true);
  if (!hidden.ok || !('box' in hidden)) return;
  assert.throws(() => assertClickable(hidden.box), (error: unknown) => {
    return error instanceof AgentRuntimeError && error.code === 'not-actionable';
  });
});

test('content is re-truncated when the page ignores the cap', () => {
  const code = buildIsolatedCall(CONTENT_SCRIPT, { maxChars: 4 });
  const parsed = readContentResult(
    runPageScript(code, ['document'], [{ documentElement: { outerHTML: 'abcdef' } }]),
    4
  );
  assert.deepEqual(parsed, { html: 'abcd', truncated: true, length: 6 });
  const hostile = readContentResult({ html: '0123456789', truncated: false, length: 10 }, 4);
  assert.deepEqual(hostile, { html: '0123', truncated: true, length: 10 });
});

test('coordinates use zoomed CSS pixels and error URLs drop credentials', () => {
  assert.deepEqual(cssPointToWidgetDip(10.4, 1.2, 2), { x: 21, y: 2 });
  assert.deepEqual(boxCenter({ x: 1, y: 2, width: 4, height: 6 }), { x: 3, y: 5 });
  assert.throws(() => cssPointToWidgetDip(0, 0, 0), (error: unknown) => {
    return error instanceof AgentRuntimeError && error.code === 'invalid-zoom';
  });
  const safe = safeUrlForError('https://user:secret@example.test/path');
  assert.equal(safe.includes('secret'), false);
  assert.equal(safe.includes('user'), false);
  assert.equal(safe.includes('example.test'), true);
  assert.throws(() => assertNavigableUrl('javascript:alert(1)'), (error: unknown) => {
    return error instanceof AgentRuntimeError && error.code === 'invalid-url';
  });
});

test('owned windows keep Electron security defaults and do not carry a preload', () => {
  const prefs = ownedWebPreferences('persist:alpha');
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.nodeIntegrationInWorker, false);
  assert.equal(prefs.nodeIntegrationInSubFrames, false);
  assert.equal(prefs.webSecurity, true);
  assert.equal(prefs.partition, 'persist:alpha');
  assert.equal('preload' in prefs, false);
  assert.equal('offscreen' in prefs, false);
});

test('key plans preserve character case and do not invent a char for Enter', () => {
  assert.deepEqual(planKey('a'), { keyCode: 'a', includeChar: true });
  assert.deepEqual(planKey('A'), { keyCode: 'A', includeChar: true });
  assert.deepEqual(planKey('Enter'), { keyCode: 'Return', includeChar: false });
  assert.deepEqual(planKey(' '), { keyCode: 'Space', includeChar: true });
  assert.throws(() => planKey('Shift'), (error: unknown) => {
    return error instanceof AgentRuntimeError && error.code === 'unsupported-key';
  });
  assert.equal(assertFillText(''), '');
  assert.throws(() => assertFillText('a'.repeat(100_001)), (error: unknown) => {
    return error instanceof AgentRuntimeError && error.code === 'invalid-size';
  });
});

function reduce(events: NavigationEvent[]) {
  let state = createNavigation('https://user:secret@example.test/start');
  for (const event of events) state = applyNavigationEvent(state, event);
  return state;
}

const realStart: NavigationEvent = {
  type: 'start',
  isMainFrame: true,
  isSameDocument: false,
  url: 'https://example.test/start'
};

test('navigation waits for its own commit and does not invent an HTTP status', () => {
  const blank = reduce([
    { type: 'start', isMainFrame: true, isSameDocument: false, url: 'about:blank' },
    { type: 'finish-load', url: 'about:blank' },
    realStart,
    { type: 'commit', url: 'https://example.test/final', httpResponseCode: 404, httpStatusText: 'Not Found' },
    { type: 'finish-load', url: 'https://example.test/final' }
  ]);
  assert.equal(blank.outcome?.type, 'success');
  if (blank.outcome?.type !== 'success') return;
  assert.equal(blank.outcome.url, 'https://example.test/final');
  assert.equal(blank.outcome.status.httpStatus, 404);
  assert.equal(blank.outcome.status.httpStatusSource, 'did-navigate');

  const file = reduce([
    realStart,
    { type: 'commit', url: 'file:///tmp/a', httpResponseCode: -1, httpStatusText: '' },
    { type: 'finish-load', url: 'file:///tmp/a' }
  ]);
  assert.equal(file.outcome?.type, 'success');
  if (file.outcome?.type !== 'success') return;
  assert.equal(file.outcome.status.httpStatus, null);
  assert.equal(file.outcome.status.httpStatusSource, 'unavailable');
});

test('a known load failure does not wait for the timeout', () => {
  const invalid = reduce([
    { type: 'fail', errorCode: -300, errorDescription: 'ERR_INVALID_URL', validatedURL: '', isMainFrame: true }
  ]);
  assert.equal(invalid.outcome?.type, 'failure');
  if (invalid.outcome?.type !== 'failure') return;
  assert.equal(invalid.outcome.code, 'navigation-failed');
  assert.equal(invalid.outcome.message.includes('secret'), false);

  const stopped = reduce([
    { type: 'load-rejected', errno: -2, message: 'ERR_FAILED (-2) loading \'https://example.test/start\'' }
  ]);
  assert.equal(stopped.outcome?.type, 'failure');

  const blankAbort = reduce([
    { type: 'fail', errorCode: NET_ERR_ABORTED, errorDescription: 'ERR_ABORTED', validatedURL: 'about:blank', isMainFrame: true },
    { type: 'load-rejected', errno: NET_ERR_ABORTED, message: 'ERR_ABORTED' },
    realStart,
    { type: 'commit', url: 'https://example.test/start', httpResponseCode: 204, httpStatusText: 'No Content' },
    { type: 'finish-load', url: 'https://example.test/start' }
  ]);
  assert.equal(blankAbort.outcome?.type, 'success');
  if (blankAbort.outcome?.type !== 'success') return;
  assert.equal(blankAbort.outcome.status.httpStatus, 204);
  assert.equal(readLoadRejection({ errno: NET_ERR_ABORTED, message: 'ERR_ABORTED' }).errno, NET_ERR_ABORTED);
});

test('redirects commit once and a competing navigation fails the attempt', () => {
  const redirect = reduce([
    realStart,
    { type: 'start', isMainFrame: false, isSameDocument: false, url: 'https://cdn.example.test/frame' },
    { type: 'start', isMainFrame: true, isSameDocument: true, url: 'https://example.test/start#section' },
    { type: 'commit', url: 'https://example.test/after', httpResponseCode: 200, httpStatusText: 'OK' },
    { type: 'finish-load', url: 'https://example.test/after' }
  ]);
  assert.equal(redirect.outcome?.type, 'success');
  if (redirect.outcome?.type !== 'success') return;
  assert.equal(redirect.outcome.status.httpStatus, 200);
  assert.equal(redirect.outcome.url, 'https://example.test/after');

  const competing = reduce([
    realStart,
    { type: 'start', isMainFrame: true, isSameDocument: false, url: 'https://other.test/' },
    { type: 'commit', url: 'https://other.test/', httpResponseCode: 200, httpStatusText: 'OK' },
    { type: 'finish-load', url: 'https://other.test/' }
  ]);
  assert.equal(competing.outcome?.type, 'failure');
  if (competing.outcome?.type !== 'failure') return;
  assert.equal(competing.outcome.code, 'navigation-failed');
  assert.equal(competing.outcome.message.includes('other.test'), true);

  const oldFinish = reduce([
    { type: 'commit', url: 'about:blank', httpResponseCode: -1, httpStatusText: '' },
    { type: 'finish-load', url: 'about:blank' }
  ]);
  assert.equal(oldFinish.outcome, null);

  const timeout = reduce([
    realStart,
    { type: 'commit', url: 'https://example.test/start', httpResponseCode: 200, httpStatusText: 'OK' },
    { type: 'timeout', timeoutMs: 200 },
    { type: 'finish-load', url: 'https://example.test/start' }
  ]);
  assert.equal(timeout.outcome?.type, 'failure');
  if (timeout.outcome?.type !== 'failure') return;
  assert.equal(timeout.outcome.code, 'timeout');

  const aborted = reduce([{ type: 'abort' }]);
  assert.equal(aborted.outcome?.type, 'failure');
  if (aborted.outcome?.type !== 'failure') return;
  assert.equal(aborted.outcome.code, 'aborted');
  const destroyed = reduce([{ type: 'destroyed' }]);
  assert.equal(destroyed.outcome?.type, 'failure');
  if (destroyed.outcome?.type !== 'failure') return;
  assert.equal(destroyed.outcome.code, 'destroyed');
});

test('a settled gate does not run click, fill, or press after a late script', async () => {
  const gate = createEffectGate();
  const effects: string[] = [];
  assert.equal(performHostEffect(gate, () => { effects.push('early'); }), true);
  settleEffectGate(gate);
  let release: (value: string) => void = () => undefined;
  const script = new Promise<string>((resolve) => {
    release = resolve;
  });
  release('element');
  const value = await script;
  if (value === 'element') {
    performHostEffect(gate, () => { effects.push('click'); });
    performHostEffect(gate, () => { effects.push('fill'); });
    performHostEffect(gate, () => { effects.push('press'); });
  }
  assert.deepEqual(effects, ['early']);

  const listeners = createListenerSet();
  const calls: string[] = [];
  listeners.add(() => { calls.push('destroyed'); });
  listeners.add(() => { calls.push('abort'); });
  listeners.close();
  listeners.close();
  listeners.add(() => { calls.push('late'); });
  assert.deepEqual(calls, ['destroyed', 'abort', 'late']);
});

test('accessibility assembly keeps relationships and refuses transformed bounds', () => {
  assert.deepEqual(assertSnapshotOptions({}), { maxNodes: 2000, timeoutMs: 10_000, framePolicy: 'all' });
  assert.throws(() => assertSnapshotOptions({ maxNodes: 0 }), (error: unknown) => {
    return error instanceof AgentRuntimeError && error.code === 'invalid-snapshot';
  });
  assert.throws(() => assertSnapshotOptions({ framePolicy: 'everything' }), (error: unknown) => {
    return error instanceof AgentRuntimeError && error.code === 'invalid-snapshot';
  });

  const tree = assembleAXSnapshot({
    rootId: 1,
    focusId: 2,
    url: 'https://example.test/',
    title: 'Example',
    framePolicy: 'same-origin',
    maxNodes: 3,
    nodes: [
      {
        id: 1,
        role: 'rootWebArea',
        name: 'Example',
        childIds: [2],
        ignored: false,
        bounds: { x: 10, y: 20, width: 100, height: 50 },
        offsetContainerId: 0,
        hasTransform: false
      },
      {
        id: 2,
        role: 'button',
        name: 'Same Child',
        childIds: [],
        ignored: false,
        bounds: { x: 5, y: 6, width: 8, height: 9 },
        offsetContainerId: 1,
        hasTransform: false
      },
      {
        id: 3,
        role: 'genericContainer',
        name: 'Shifted',
        childIds: [4],
        ignored: true,
        bounds: { x: 1, y: 1, width: 4, height: 4 },
        offsetContainerId: 0,
        hasTransform: true
      },
      {
        id: 4,
        role: 'staticText',
        name: 'Inside',
        childIds: [],
        ignored: false,
        bounds: { x: 2, y: 2, width: 1, height: 1 },
        offsetContainerId: 3,
        hasTransform: false
      }
    ]
  });
  assert.equal(tree.framePolicy, 'same-origin');
  assert.equal(tree.stitching, 'chromium-ax-tree-combiner');
  assert.equal(tree.mayBeTruncated, true);
  assert.equal(tree.nodeCount, 4);
  const button = tree.nodes.find((node) => node.id === 2);
  assert.equal(button?.parentId, 1);
  assert.equal(button?.boundsSpace, 'offset-container');
  assert.deepEqual(button?.resolvedBounds, { x: 15, y: 26, width: 8, height: 9 });
  const root = tree.nodes.find((node) => node.id === 1);
  assert.equal(root?.parentId, null);
  assert.equal(root?.boundsSpace, 'containing-node');
  assert.deepEqual(root?.resolvedBounds, { x: 10, y: 20, width: 100, height: 50 });
  const shifted = tree.nodes.find((node) => node.id === 3);
  assert.equal(shifted?.resolvedBounds, null);
  assert.equal(shifted?.boundsSpace, 'tree-root');
  const inside = tree.nodes.find((node) => node.id === 4);
  assert.equal(inside?.parentId, 3);
  assert.equal(inside?.resolvedBounds, null);

  const relativeToRoot = assembleAXSnapshot({
    rootId: 1,
    focusId: 0,
    url: '',
    title: '',
    framePolicy: 'all',
    maxNodes: 10,
    nodes: [
      {
        id: 1,
        role: 'rootWebArea',
        name: '',
        childIds: [2],
        ignored: false,
        bounds: { x: 0, y: 0, width: 10, height: 10 },
        offsetContainerId: 0,
        hasTransform: false
      },
      {
        id: 2,
        role: 'genericContainer',
        name: 'Child',
        childIds: [],
        ignored: false,
        bounds: { x: 3, y: 4, width: 1, height: 1 },
        offsetContainerId: 0,
        hasTransform: false
      }
    ]
  });
  assert.equal(relativeToRoot.focusId, null);
  assert.equal(relativeToRoot.mayBeTruncated, false);
  assert.equal(relativeToRoot.nodes[1]?.boundsSpace, 'tree-root');
  assert.deepEqual(relativeToRoot.nodes[1]?.resolvedBounds, { x: 3, y: 4, width: 1, height: 1 });
  assert.throws(() => assembleAXSnapshot({ framePolicy: 'all', maxNodes: 1, url: '', title: '', nodes: [] }), (error: unknown) => {
    return error instanceof AgentRuntimeError && error.code === 'snapshot-failed';
  });
});

function responseEvent(extra: Partial<ResponseObservationEvent> = {}): ResponseObservationEvent {
  return {
    requestId: '7',
    phase: 'completed',
    url: 'https://example.test/item',
    redirectUrl: '',
    status: 200,
    mimeType: 'application/octet-stream',
    networkDecoded: true,
    truncated: false,
    skipReason: '',
    errorCode: 0,
    queueDropped: 0,
    body: new Uint8Array([0, 255, 128, 65, 66]),
    ...extra
  };
}

test('response observation limits match the native constants and reject bad options', () => {
  assert.equal(RESPONSE_DEFAULT_MAX_BYTES, 1_000_000);
  assert.equal(RESPONSE_MAX_BYTES, 10_000_000);
  assert.equal(RESPONSE_DEFAULT_MAX_IN_FLIGHT, 8);
  assert.equal(RESPONSE_MAX_IN_FLIGHT, 64);
  assert.equal(RESPONSE_DEFAULT_AGGREGATE_BYTES, 8_000_000);
  assert.equal(RESPONSE_MAX_AGGREGATE_BYTES, 64_000_000);
  const policy = normalizeResponseObservation(undefined);
  assert.equal(policy.maxBytesPerResponse, RESPONSE_DEFAULT_MAX_BYTES);
  assert.deepEqual(policy.urls, []);
  assert.throws(() => normalizeResponseObservation({ maxBytesPerResponse: 0 }), (error: unknown) => {
    return error instanceof AgentRuntimeError && error.code === 'invalid-response-observation';
  });
  assert.throws(() => normalizeResponseObservation({ urls: ['http://ok/*', 'bad*pattern*'] }), (error: unknown) => {
    return error instanceof AgentRuntimeError && error.code === 'invalid-response-observation';
  });
  assert.equal(responseUrlMatches([], 'https://example.test/a'), true);
  assert.equal(responseUrlMatches([], 'file:///tmp/a'), false);
  assert.equal(responseUrlMatches(['https://example.test/'], 'https://example.test/a'), true);
  assert.equal(responseUrlMatches(['https://example.test/*/tail'], 'https://example.test/a/tail'), true);
  assert.equal(responseUrlMatches(['https://example.test/'], 'https://other.test/'), false);
});

test('response delivery keeps exact bytes, skips overflow, and invents no redirect body', () => {
  const policy = normalizeResponseObservation({
    urls: ['https://example.test/'],
    maxBytesPerResponse: 4,
    maxInFlight: 1,
    maxAggregateBytes: 4
  });
  const budget = createResponseObservationBudget();
  const opened = applyResponseObservation(policy, budget, responseEvent({ phase: 'opened', body: null }));
  assert.equal(opened?.phase, 'opened');
  assert.equal(opened?.body, null);
  assert.equal(budget.inFlight, 1);
  const blocked = applyResponseObservation(policy, budget, responseEvent({
    phase: 'opened',
    requestId: '8',
    body: null
  }));
  assert.equal(blocked?.phase, 'skipped');
  assert.equal(blocked?.skipReason, 'in-flight-limit');
  assert.equal(blocked?.body, null);
  const redirect = applyResponseObservation(policy, budget, responseEvent({
    phase: 'redirect',
    redirectUrl: 'https://example.test/next',
    status: 302,
    body: new Uint8Array([1, 2, 3, 4])
  }));
  assert.equal(redirect?.body, null);
  assert.equal(redirect?.status, 302);
  const completed = applyResponseObservation(policy, budget, responseEvent());
  assert.equal(completed?.truncated, true);
  assert.deepEqual(Array.from(completed?.body ?? []), [0, 255, 128, 65]);
  assert.equal(budget.inFlight, 0);
  const other = applyResponseObservation(policy, budget, responseEvent({
    phase: 'completed',
    requestId: '9',
    url: 'https://other.test/'
  }));
  assert.equal(other, null);
  const union = unionResponseObservationPolicies([
    policy,
    normalizeResponseObservation({ urls: ['https://other.test/'], maxBytesPerResponse: 8, maxInFlight: 2, maxAggregateBytes: 9 })
  ]);
  assert.deepEqual(union.urls, ['https://example.test/', 'https://other.test/']);
  assert.equal(union.maxBytesPerResponse, 8);
  assert.equal(union.maxInFlight, 2);
  const caughtAll = unionResponseObservationPolicies([policy, normalizeResponseObservation({})]);
  assert.deepEqual(caughtAll.urls, []);
  assert.equal(completed?.queueDropped, 0);
});

function socketEvent(extra: Partial<WebSocketObservationEvent> = {}): WebSocketObservationEvent {
  return {
    connectionId: '1',
    messageId: 'm1',
    phase: 'message',
    url: 'ws://127.0.0.1/socket',
    direction: 'received',
    opcode: 'text',
    body: new Uint8Array([104, 105]),
    text: null,
    truncated: false,
    skipReason: '',
    wireCompressed: false,
    wasClean: false,
    code: 0,
    reason: '',
    errorCode: 0,
    queueDropped: 0,
    ...extra
  };
}

test('websocket observation copies exact bytes and decodes only complete text', () => {
  assert.equal(normalizeWebSocketObservation({}).maxBytesPerMessage, WEBSOCKET_DEFAULT_MAX_BYTES);
  assert.throws(() => normalizeWebSocketObservation({ maxBytesPerMessage: 0 }), (error: unknown) => {
    return error instanceof AgentRuntimeError && error.code === 'invalid-websocket-observation';
  });
  assert.equal(websocketUrlMatches([], 'ws://127.0.0.1/socket'), true);
  assert.equal(websocketUrlMatches([], 'https://127.0.0.1/socket'), false);
  assert.equal(websocketUrlMatches(['wss://example.test/*'], 'wss://example.test/a'), true);

  const policy = normalizeWebSocketObservation({
    urls: ['ws://127.0.0.1/'],
    maxBytesPerMessage: 4,
    maxInFlight: 1,
    maxAggregateBytes: 8
  });
  const budget = createWebSocketObservationBudget();
  const opened = applyWebSocketObservation(policy, budget, socketEvent({ phase: 'opened', body: null, messageId: '' }));
  assert.equal(opened?.phase, 'opened');
  assert.equal(budget.inFlight, 1);
  const blocked = applyWebSocketObservation(policy, budget, socketEvent({
    phase: 'opened',
    connectionId: '2',
    body: null,
    messageId: ''
  }));
  assert.equal(blocked?.phase, 'skipped');
  assert.equal(blocked?.skipReason, 'in-flight-limit');
  assert.equal(applyWebSocketObservation(policy, budget, socketEvent({
    phase: 'message',
    connectionId: '2',
    messageId: 'm2'
  })), null);

  const text = applyWebSocketObservation(policy, budget, socketEvent());
  assert.equal(text?.text, 'hi');
  assert.deepEqual(Array.from(text?.body ?? []), [104, 105]);
  const empty = applyWebSocketObservation(policy, budget, socketEvent({ body: new Uint8Array() }));
  assert.equal(empty?.text, '');
  assert.equal(empty?.body?.byteLength, 0);
  const binary = applyWebSocketObservation(policy, budget, socketEvent({
    opcode: 'binary',
    body: new Uint8Array([0, 255])
  }));
  assert.equal(binary?.text, null);
  assert.deepEqual(Array.from(binary?.body ?? []), [0, 255]);
  const invalid = applyWebSocketObservation(policy, budget, socketEvent({ body: new Uint8Array([0xff]) }));
  assert.equal(invalid?.text, null);
  assert.deepEqual(Array.from(invalid?.body ?? []), [0xff]);
  const truncated = applyWebSocketObservation(policy, budget, socketEvent({
    body: new Uint8Array([97, 98, 99, 100, 101])
  }));
  assert.equal(truncated?.truncated, true);
  assert.equal(truncated?.text, null);
  assert.deepEqual(Array.from(truncated?.body ?? []), [97, 98, 99, 100]);
  const other = applyWebSocketObservation(policy, budget, socketEvent({ url: 'ws://other.test/' }));
  assert.equal(other, null);
  const closed = applyWebSocketObservation(policy, budget, socketEvent({ phase: 'closed', wasClean: true, code: 1000 }));
  assert.equal(closed?.body, null);
  assert.equal(budget.inFlight, 0);

  const union = unionWebSocketObservationPolicies([
    policy,
    normalizeWebSocketObservation({ urls: ['wss://example.test/'], maxBytesPerMessage: 8, maxInFlight: 2, maxAggregateBytes: 9 })
  ]);
  assert.deepEqual(union.urls, ['ws://127.0.0.1/', 'wss://example.test/']);
  assert.equal(union.maxBytesPerMessage, 8);
  const caughtAll = unionWebSocketObservationPolicies([policy, normalizeWebSocketObservation({})]);
  assert.deepEqual(caughtAll.urls, []);
});

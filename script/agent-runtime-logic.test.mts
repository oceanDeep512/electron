import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

import {
  AgentRuntimeError,
  CONTENT_SCRIPT,
  ELEMENT_SCRIPT,
  assertClickable,
  assertFillText,
  assertNavigableUrl,
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
  personaStorageId,
  planKey,
  readContentResult,
  readElementResult,
  readNavigationStart,
  releaseSlot,
  resolvePartition,
  safeUrlForError,
  shouldArmNavigation,
  validatePersona,
  type Persona
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

test('checkpoint records the pinned baseline and leaves native stages off', () => {
  assert.equal(checkpoint.baseline, 'ef2710fa6c10fe56365a9949fa783d26ca1499e5');
  assert.equal(checkpoint.chromium, '159.0.8140.0');
  assert.equal(checkpoint.controlPlane, true);
  assert.equal(checkpoint.nativePersona, false);
  assert.equal(checkpoint.accessibilitySnapshot, false);
  assert.equal(checkpoint.responseBodyObservation, false);
  assert.equal(checkpoint.webSocketMessageObservation, false);
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
  const reserved = partitionRecordForReuse(undefined, 'persona-a', false);
  assert.equal(reserved?.personaApplied, true);
  assert.throws(
    () => checkPartitionReuse(reserved, memory),
    (error: unknown) => error instanceof AgentRuntimeError && error.code === 'partition-conflict'
  );
  assert.throws(
    () => partitionRecordForReuse(
      { persist: false, personaApplied: false, personaId: null },
      'persona-a',
      false
    ),
    (error: unknown) => error instanceof AgentRuntimeError && error.code === 'partition-conflict'
  );
});

test('a valid persona is rejected as unavailable and is not treated as applied', () => {
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
  const validated = validatePersona(validPersona());
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  const decision = decidePersona(validPersona());
  assert.equal(decision.action, 'unavailable');
  if (decision.action !== 'unavailable') return;
  assert.equal(decision.persona.userAgentMetadata.model, '');
  assert.equal(personaStorageId(decision.persona), personaStorageId(validated.persona));
  const again = JSON.parse(personaStorageId(decision.persona)) as Persona;
  assert.equal(personaStorageId(again), personaStorageId(decision.persona));
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

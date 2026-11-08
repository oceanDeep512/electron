// Pure decisions for agentRuntime. This file must not import Electron or
// apply any renderer, network, or process-wide setting.

export const checkpoint = Object.freeze({
  baseline: 'ef2710fa6c10fe56365a9949fa783d26ca1499e5',
  chromium: '159.0.8140.0',
  electron: '47.0.0-nightly.20261106',
  // Pages this module creates use this isolated world. 0 is the page world
  // and 999 is reserved by Electron contextIsolation.
  isolatedWorldId: 1001,
  maxInFlight: 4,
  defaultNavigationTimeoutMs: 30_000,
  defaultActionTimeoutMs: 10_000,
  maxTimeoutMs: 120_000,
  controlPlane: true,
  nativePersona: false,
  // The snapshot API is wired to WebContents::RequestAXTreeSnapshot.
  // HTTP response bodies and WebSocket message bodies are not.
  accessibilitySnapshot: true,
  responseBodyObservation: false,
  webSocketMessageObservation: false
} as const);

export type AgentErrorCode =
  | 'invalid-persona'
  | 'native-persona-unavailable'
  | 'invalid-partition'
  | 'partition-conflict'
  | 'partition-mismatch'
  | 'app-not-ready'
  | 'closed'
  | 'destroyed'
  | 'crashed'
  | 'timeout'
  | 'aborted'
  | 'navigation-failed'
  | 'navigation-in-progress'
  | 'busy'
  | 'invalid-url'
  | 'invalid-selector'
  | 'not-found'
  | 'not-actionable'
  | 'not-editable'
  | 'unsupported-key'
  | 'invalid-button'
  | 'invalid-timeout'
  | 'invalid-zoom'
  | 'invalid-size'
  | 'invalid-snapshot'
  | 'snapshot-failed'
  | 'page-script-failed';

export class AgentRuntimeError extends Error {
  readonly code: AgentErrorCode;

  constructor(code: AgentErrorCode, message: string) {
    super(message);
    this.name = 'AgentRuntimeError';
    this.code = code;
  }
}

export interface ResolvedPartition {
  /** String passed to session.fromPartition. Includes persist: when persistent. */
  storagePartition: string;
  persist: boolean;
  /** Partition name with at most one persist: prefix removed. */
  name: string;
}

const PARTITION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function resolvePartition(options: { partition: unknown; persist?: unknown }): ResolvedPartition {
  if (typeof options.partition !== 'string') {
    throw new AgentRuntimeError('invalid-partition', 'partition must be a string');
  }
  if (options.persist !== undefined && typeof options.persist !== 'boolean') {
    throw new AgentRuntimeError('invalid-partition', 'persist must be a boolean when provided');
  }

  const raw = options.partition;
  if (raw.length === 0) {
    throw new AgentRuntimeError(
      'invalid-partition',
      'partition must be non-empty so agentRuntime never attaches to the default session'
    );
  }
  if (raw.startsWith('persist:persist:')) {
    throw new AgentRuntimeError('invalid-partition', 'partition must not contain a repeated persist: prefix');
  }

  const prefixed = raw.startsWith('persist:');
  const name = prefixed ? raw.slice('persist:'.length) : raw;
  if (!PARTITION_NAME.test(name) || name.includes('..')) {
    throw new AgentRuntimeError(
      'invalid-partition',
      'partition name must be 1-128 characters of letters, digits, ".", "_" or "-", and must not contain ".."'
    );
  }

  if (options.persist === false && prefixed) {
    throw new AgentRuntimeError(
      'partition-conflict',
      `partition "${raw}" is persistent, which conflicts with persist: false`
    );
  }

  const persist = options.persist === undefined ? prefixed : options.persist;
  const storagePartition = persist ? `persist:${name}` : name;
  return { storagePartition, persist, name };
}

export interface PartitionRecord {
  persist: boolean;
  /** True only after the native stage has applied a persona to this partition. */
  personaApplied: boolean;
  /**
   * Identity from personaStorageId. Null means no persona was applied.
   * Close does not clear a non-null id: the BrowserContext keeps it.
   */
  personaId: string | null;
}

export function checkPartitionReuse(
  existing: PartitionRecord | undefined,
  next: ResolvedPartition & { personaId: string | null }
): 'create' | 'reuse' {
  if (!existing) return 'create';
  const appliedWithoutId = existing.personaApplied && existing.personaId === null;
  if (existing.persist !== next.persist || existing.personaId !== next.personaId || appliedWithoutId) {
    throw new AgentRuntimeError(
      'partition-conflict',
      `partition "${next.storagePartition}" is already in use with incompatible persist or persona options`
    );
  }
  return 'reuse';
}

// Canonical JSON for a later native stage. createSession does not call this
// and does not store the result.
export function personaStorageId(persona: Persona): string {
  return JSON.stringify(persona);
}

export interface SlotState {
  inflight: number;
}

export function claimSlot(state: SlotState, maxInFlight: number): void {
  if (state.inflight >= maxInFlight) {
    throw new AgentRuntimeError(
      'busy',
      `Too many agentRuntime operations are already running (limit ${maxInFlight})`
    );
  }
  state.inflight += 1;
}

export function releaseSlot(state: SlotState): void {
  state.inflight = Math.max(0, state.inflight - 1);
}

const FORM_FACTORS = new Set(['Desktop', 'Automotive', 'Mobile', 'Tablet', 'XR', 'EInk', 'Watch']);
const WEBRTC_POLICIES = new Set([
  'default',
  'default_public_interface_only',
  'default_public_and_private_interfaces',
  'disable_non_proxied_udp'
]);
const DEVICE_MEMORY_BUCKETS = new Set([0.25, 0.5, 1, 2, 4, 8, 16, 32, 64]);
const COLOR_DEPTHS = new Set([8, 16, 24, 30, 32, 48]);
const LANGUAGE = /^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*$/;
const TIMEZONE = /^(?:UTC|GMT|[A-Za-z0-9_+-]{1,32}(?:\/[A-Za-z0-9_+-]{1,32}){1,2})$/;

export interface Persona {
  seed: string;
  userAgent: string;
  userAgentMetadata: {
    brands: { brand: string; version: string }[];
    fullVersionList: { brand: string; version: string }[];
    fullVersion: string;
    platform: string;
    platformVersion: string;
    architecture: string;
    bitness: string;
    model: string;
    mobile: boolean;
    wow64: boolean;
    formFactors: string[];
  };
  acceptLanguages: string[];
  timezone: string;
  hardwareConcurrency: number;
  deviceMemory: number;
  screen: {
    width: number;
    height: number;
    availWidth: number;
    availHeight: number;
    colorDepth: number;
    deviceScaleFactor: number;
  };
  webgl: { vendor: string; renderer: string };
  webgpu: { vendor: string; architecture: string; device: string; description: string };
  webrtcIpHandlingPolicy:
    | 'default'
    | 'default_public_interface_only'
    | 'default_public_and_private_interfaces'
    | 'disable_non_proxied_udp';
  fontPolicy: 'real' | 'core';
}

export type PersonaValidation =
  | { ok: true; persona: Persona }
  | { ok: false; errors: string[] };

export type PersonaDecision =
  | { action: 'omit' }
  | { action: 'invalid'; errors: string[] }
  | { action: 'unavailable'; persona: Persona };

const PERSONA_KEYS = [
  'seed',
  'userAgent',
  'userAgentMetadata',
  'acceptLanguages',
  'timezone',
  'hardwareConcurrency',
  'deviceMemory',
  'screen',
  'webgl',
  'webgpu',
  'webrtcIpHandlingPolicy',
  'fontPolicy'
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unknownKeys(value: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(value).filter((key) => !allowed.includes(key));
}

function pushUnknown(errors: string[], label: string, value: Record<string, unknown>, allowed: readonly string[]) {
  const extra = unknownKeys(value, allowed);
  if (extra.length > 0) {
    errors.push(`${label} has unsupported fields: ${extra.join(', ')}`);
  }
}

function nonEmptyString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001F\u007F]/.test(value);
}

function brandList(value: unknown, errors: string[], label: string): { brand: string; version: string }[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) {
    errors.push(`${label} must be an array of 1 to 8 brand entries`);
    return null;
  }
  const brands: { brand: string; version: string }[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      errors.push(`${label} entries must be objects`);
      return null;
    }
    pushUnknown(errors, label, entry, ['brand', 'version']);
    if (!nonEmptyString(entry.brand, 64) || !nonEmptyString(entry.version, 64)) {
      errors.push(`${label} entries need non-empty brand and version strings`);
      return null;
    }
    brands.push({ brand: entry.brand, version: entry.version });
  }
  return brands;
}

export function validatePersona(value: unknown): PersonaValidation {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { ok: false, errors: ['persona must be an object'] };
  }
  pushUnknown(errors, 'persona', value, PERSONA_KEYS);
  if (!nonEmptyString(value.seed, 256)) errors.push('seed must be a non-empty string without control characters');
  if (!nonEmptyString(value.userAgent, 512)) {
    errors.push('userAgent must be a non-empty string without control characters');
  }
  if (!Array.isArray(value.acceptLanguages) || value.acceptLanguages.length === 0 || value.acceptLanguages.length > 16) {
    errors.push('acceptLanguages must contain 1 to 16 language tags');
  } else if (!value.acceptLanguages.every((tag) => typeof tag === 'string' && LANGUAGE.test(tag))) {
    errors.push('acceptLanguages entries must be BCP 47-like tags such as zh-CN');
  }
  if (typeof value.timezone !== 'string' || !TIMEZONE.test(value.timezone)) {
    errors.push('timezone must be a syntactic IANA id, UTC, or GMT; ICU acceptance is checked only by the native stage');
  }
  if (!Number.isInteger(value.hardwareConcurrency) || (value.hardwareConcurrency as number) < 1 || (value.hardwareConcurrency as number) > 1024) {
    errors.push('hardwareConcurrency must be an integer from 1 to 1024');
  }
  if (typeof value.deviceMemory !== 'number' || !DEVICE_MEMORY_BUCKETS.has(value.deviceMemory)) {
    errors.push('deviceMemory must be one of 0.25, 0.5, 1, 2, 4, 8, 16, 32, 64');
  }
  if (!WEBRTC_POLICIES.has(value.webrtcIpHandlingPolicy as string)) {
    errors.push('webrtcIpHandlingPolicy is not one of the four existing Electron policies');
  }
  if (value.fontPolicy !== 'real' && value.fontPolicy !== 'core') {
    errors.push("fontPolicy must be 'real' or 'core'");
  }

  let metadata: Persona['userAgentMetadata'] | null = null;
  if (!isRecord(value.userAgentMetadata)) {
    errors.push('userAgentMetadata must be an object');
  } else {
    pushUnknown(errors, 'userAgentMetadata', value.userAgentMetadata, [
      'brands',
      'fullVersionList',
      'fullVersion',
      'platform',
      'platformVersion',
      'architecture',
      'bitness',
      'model',
      'mobile',
      'wow64',
      'formFactors'
    ]);
    const brands = brandList(value.userAgentMetadata.brands, errors, 'brands');
    const fullVersionList = brandList(value.userAgentMetadata.fullVersionList, errors, 'fullVersionList');
    const requiredStrings = ['fullVersion', 'platform', 'platformVersion', 'architecture', 'bitness'] as const;
    for (const key of requiredStrings) {
      if (!nonEmptyString(value.userAgentMetadata[key], 128)) {
        errors.push(`userAgentMetadata.${key} must be a non-empty string without control characters`);
      }
    }
    if (value.userAgentMetadata.model !== '' && !nonEmptyString(value.userAgentMetadata.model, 128)) {
      errors.push('userAgentMetadata.model must be a string without control characters');
    }
    if (typeof value.userAgentMetadata.mobile !== 'boolean' || typeof value.userAgentMetadata.wow64 !== 'boolean') {
      errors.push('userAgentMetadata.mobile and wow64 must be booleans');
    }
    if (!Array.isArray(value.userAgentMetadata.formFactors) || value.userAgentMetadata.formFactors.length === 0) {
      errors.push('userAgentMetadata.formFactors must be a non-empty array');
    } else if (!value.userAgentMetadata.formFactors.every((factor) => typeof factor === 'string' && FORM_FACTORS.has(factor))) {
      errors.push('userAgentMetadata.formFactors contains an unknown form factor');
    }
    if (
      brands &&
      fullVersionList &&
      typeof value.userAgentMetadata.mobile === 'boolean' &&
      typeof value.userAgentMetadata.wow64 === 'boolean' &&
      Array.isArray(value.userAgentMetadata.formFactors)
    ) {
      metadata = {
        brands,
        fullVersionList,
        fullVersion: String(value.userAgentMetadata.fullVersion ?? ''),
        platform: String(value.userAgentMetadata.platform ?? ''),
        platformVersion: String(value.userAgentMetadata.platformVersion ?? ''),
        architecture: String(value.userAgentMetadata.architecture ?? ''),
        bitness: String(value.userAgentMetadata.bitness ?? ''),
        model: String(value.userAgentMetadata.model ?? ''),
        mobile: value.userAgentMetadata.mobile,
        wow64: value.userAgentMetadata.wow64,
        formFactors: value.userAgentMetadata.formFactors as string[]
      };
    }
  }

  let screen: Persona['screen'] | null = null;
  if (!isRecord(value.screen)) {
    errors.push('screen must be an object');
  } else {
    pushUnknown(errors, 'screen', value.screen, [
      'width',
      'height',
      'availWidth',
      'availHeight',
      'colorDepth',
      'deviceScaleFactor'
    ]);
    const screenRecord = value.screen;
    const dims = ['width', 'height', 'availWidth', 'availHeight'] as const;
    const okDims = dims.every((key) => {
      const dimension = screenRecord[key];
      return typeof dimension === 'number' && Number.isInteger(dimension) && dimension > 0 && dimension <= 16384;
    });
    if (!okDims) errors.push('screen dimensions must be positive integers up to 16384');
    if (!COLOR_DEPTHS.has(value.screen.colorDepth as number)) errors.push('screen.colorDepth is not a supported depth');
    if (typeof value.screen.deviceScaleFactor !== 'number' || !(value.screen.deviceScaleFactor > 0) || value.screen.deviceScaleFactor > 8) {
      errors.push('screen.deviceScaleFactor must be a number in (0, 8]');
    }
    if (okDims && (value.screen.availWidth as number) > (value.screen.width as number)) {
      errors.push('screen.availWidth cannot exceed width');
    }
    if (okDims && (value.screen.availHeight as number) > (value.screen.height as number)) {
      errors.push('screen.availHeight cannot exceed height');
    }
    if (okDims && COLOR_DEPTHS.has(value.screen.colorDepth as number)) {
      screen = {
        width: value.screen.width as number,
        height: value.screen.height as number,
        availWidth: value.screen.availWidth as number,
        availHeight: value.screen.availHeight as number,
        colorDepth: value.screen.colorDepth as number,
        deviceScaleFactor: value.screen.deviceScaleFactor as number
      };
    }
  }

  const webgl = stringPair(value.webgl, 'webgl', ['vendor', 'renderer'], errors);
  const webgpu = stringPair(value.webgpu, 'webgpu', ['vendor', 'architecture', 'device', 'description'], errors);

  if (errors.length > 0 || !metadata || !screen || !webgl || !webgpu) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    persona: {
      seed: value.seed as string,
      userAgent: value.userAgent as string,
      userAgentMetadata: metadata,
      acceptLanguages: value.acceptLanguages as string[],
      timezone: value.timezone as string,
      hardwareConcurrency: value.hardwareConcurrency as number,
      deviceMemory: value.deviceMemory as number,
      screen,
      webgl: webgl as Persona['webgl'],
      webgpu: webgpu as Persona['webgpu'],
      webrtcIpHandlingPolicy: value.webrtcIpHandlingPolicy as Persona['webrtcIpHandlingPolicy'],
      fontPolicy: value.fontPolicy as Persona['fontPolicy']
    }
  };
}

function stringPair(
  value: unknown,
  label: string,
  keys: readonly string[],
  errors: string[]
): Record<string, string> | null {
  if (!isRecord(value)) {
    errors.push(`${label} must be an object`);
    return null;
  }
  pushUnknown(errors, label, value, keys);
  const result: Record<string, string> = {};
  for (const key of keys) {
    if (!nonEmptyString(value[key], 256)) {
      errors.push(`${label}.${key} must be a non-empty string without control characters`);
      return null;
    }
    result[key] = value[key] as string;
  }
  return result;
}

export function decidePersona(persona: unknown): PersonaDecision {
  if (persona === undefined) return { action: 'omit' };
  if (persona === null) {
    return {
      action: 'invalid',
      errors: ['persona must be omitted; null does not apply an empty fingerprint']
    };
  }
  const validated = validatePersona(persona);
  if (!validated.ok) return { action: 'invalid', errors: validated.errors };
  // A valid config is still not applied. The native stage has to run first.
  return { action: 'unavailable', persona: validated.persona };
}

export function assertTimeoutMs(value: unknown, fallback: number): number {
  const timeout = value === undefined ? fallback : value;
  if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 1 || timeout > checkpoint.maxTimeoutMs) {
    throw new AgentRuntimeError(
      'invalid-timeout',
      `timeoutMs must be an integer from 1 to ${checkpoint.maxTimeoutMs}`
    );
  }
  return timeout;
}

export function assertNavigableUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_000_000) {
    throw new AgentRuntimeError('invalid-url', 'url must be a non-empty string');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new AgentRuntimeError('invalid-url', 'url must be absolute');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'file:' && parsed.protocol !== 'data:') {
    throw new AgentRuntimeError('invalid-url', `url protocol ${parsed.protocol} is not navigable by agentRuntime`);
  }
  return value;
}

export function safeUrlForError(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) {
      parsed.username = '';
      parsed.password = '';
    }
    const text = parsed.toString();
    return text.length > 300 ? `${text.slice(0, 300)}…` : text;
  } catch {
    return '[invalid URL]';
  }
}

export interface NavigationStatus {
  httpStatus: number | null;
  httpStatusText: string;
  httpStatusSource: 'did-navigate' | 'unavailable';
}

// loadURL does not report an HTTP status. Only a did-navigate code in the
// HTTP range is surfaced, and nothing here substitutes a success code.
export function httpStatusFromNavigateEvent(code: unknown, text: unknown): NavigationStatus {
  if (typeof code === 'number' && Number.isInteger(code) && code >= 100 && code <= 599) {
    return {
      httpStatus: code,
      httpStatusText: typeof text === 'string' ? text : '',
      httpStatusSource: 'did-navigate'
    };
  }
  return { httpStatus: null, httpStatusText: '', httpStatusSource: 'unavailable' };
}

export function assertSelector(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2000 || value.includes('\u0000')) {
    throw new AgentRuntimeError('invalid-selector', 'selector must be a CSS selector string of 1 to 2000 characters');
  }
  return value;
}

export function assertMouseButton(value: unknown): 'left' | 'middle' | 'right' {
  if (value === undefined) return 'left';
  if (value === 'left' || value === 'middle' || value === 'right') return value;
  throw new AgentRuntimeError('invalid-button', "button must be 'left', 'middle', or 'right'");
}

export function assertContentMaxChars(value: unknown): number {
  const max = value === undefined ? 200_000 : value;
  if (typeof max !== 'number' || !Number.isInteger(max) || max < 1 || max > 1_000_000) {
    throw new AgentRuntimeError('invalid-size', 'maxChars must be an integer from 1 to 1000000');
  }
  return max;
}

export function assertFillText(value: unknown): string {
  if (typeof value !== 'string') {
    throw new AgentRuntimeError('not-editable', 'fill text must be a string');
  }
  if (value.includes('\u0000')) {
    throw new AgentRuntimeError('not-editable', 'fill text must not contain NUL');
  }
  if (value.length > 100_000) {
    throw new AgentRuntimeError('invalid-size', 'fill text must be at most 100000 characters');
  }
  return value;
}

export function readNavigationStart(args: readonly unknown[]): { isMainFrame: boolean; isSameDocument: boolean; url: string } | null {
  const first = args[0];
  if (typeof first !== 'object' || first === null || Array.isArray(first)) return null;
  const details = first as Record<string, unknown>;
  if (typeof details.isMainFrame !== 'boolean') return null;
  return {
    isMainFrame: details.isMainFrame,
    isSameDocument: details.isSameDocument === true,
    url: typeof details.url === 'string' ? details.url : ''
  };
}

// The initial BrowserWindow document is about:blank. Arming on it would
// report that load instead of the loadURL this call started.
export function shouldArmNavigation(start: { isMainFrame: boolean; isSameDocument: boolean; url: string }): boolean {
  if (!start.isMainFrame || start.isSameDocument) return false;
  if (start.url.startsWith('about:')) return false;
  return true;
}

export function isForeignFailureUrl(validatedUrl: unknown, requestedUrl: string): boolean {
  return typeof validatedUrl === 'string' && validatedUrl.startsWith('about:') && !requestedUrl.startsWith('about:');
}

export function assertPageSize(width: unknown, height: unknown): { width: number; height: number } {
  const w = width === undefined ? 800 : width;
  const h = height === undefined ? 600 : height;
  if (typeof w !== 'number' || typeof h !== 'number' || !Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > 7680 || h > 7680) {
    throw new AgentRuntimeError('invalid-size', 'width and height must be integers from 1 to 7680');
  }
  return { width: w, height: h };
}

export interface OwnedWebPreferences {
  sandbox: true;
  contextIsolation: true;
  nodeIntegration: false;
  nodeIntegrationInWorker: false;
  nodeIntegrationInSubFrames: false;
  webSecurity: true;
  partition: string;
}

export function ownedWebPreferences(storagePartition: string): OwnedWebPreferences {
  return {
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    partition: storagePartition
  };
}

export function cssPointToWidgetDip(cssX: number, cssY: number, zoomFactor: number): { x: number; y: number } {
  if (typeof zoomFactor !== 'number' || !Number.isFinite(zoomFactor) || zoomFactor <= 0) {
    throw new AgentRuntimeError('invalid-zoom', 'zoomFactor must be a positive finite number');
  }
  return {
    x: Math.round(cssX * zoomFactor),
    y: Math.round(cssY * zoomFactor)
  };
}

export function boxCenter(box: { x: number; y: number; width: number; height: number }): { x: number; y: number } {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

const NAMED_KEYS: Record<string, string> = {
  Enter: 'Return',
  Return: 'Return',
  Escape: 'Escape',
  Esc: 'Escape',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  Left: 'Left',
  Right: 'Right',
  Up: 'Up',
  Down: 'Down',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Space: 'Space'
};

// Space is a character DomKey, so the char converter turns it into " ".
// Return and Tab are named keys; a char event would insert the word itself.
const PRINTABLE_NAMED = new Set(['Space']);
const SINGLE_CHAR = /^[A-Za-z0-9 !@#$%^&*():;+\-<,_.>?/`~[\]\\|'"]$/;

export interface KeyPlan {
  keyCode: string;
  includeChar: boolean;
}

export function planKey(key: unknown): KeyPlan {
  if (typeof key !== 'string' || key.length === 0) {
    throw new AgentRuntimeError('unsupported-key', 'key must be a non-empty string');
  }
  const named = NAMED_KEYS[key];
  if (named) return { keyCode: named, includeChar: PRINTABLE_NAMED.has(named) };
  if (SINGLE_CHAR.test(key)) {
    if (key === ' ') return { keyCode: 'Space', includeChar: true };
    // Keep the original character. A one-character token is lowercased only
    // for the virtual-key lookup, while the char event copies this token.
    return { keyCode: key, includeChar: true };
  }
  throw new AgentRuntimeError('unsupported-key', `Unsupported key ${JSON.stringify(key)}. Modifiers are not accepted in this checkpoint.`);
}

export function buildIsolatedCall(functionSource: string, args: unknown): string {
  return `(${functionSource})(${JSON.stringify(args)})`;
}

// Main frame only. The selector arrives as a JSON value, never as raw source.
export const ELEMENT_SCRIPT = `function(args) {
  if (typeof args.selector !== 'string' || args.selector.length === 0) {
    return { ok: false, reason: 'invalid-selector', message: 'empty selector' };
  }
  let el;
  try {
    el = document.querySelector(args.selector);
  } catch (error) {
    const message = error && error.message ? String(error.message) : String(error);
    return { ok: false, reason: 'invalid-selector', message: message };
  }
  if (!el) return { ok: false, reason: 'not-found' };
  if (args.action === 'value') {
    if (typeof el.value !== 'string') return { ok: false, reason: 'not-editable' };
    return { ok: true, value: el.value };
  }
  if (args.scroll && typeof el.scrollIntoView === 'function') {
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
  }
  const style = getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  const disabled = Boolean(el.disabled);
  const visible = style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && rect.width > 0 && rect.height > 0;
  const editable = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable === true;
  if (args.action === 'focus-editable') {
    if (!editable) return { ok: false, reason: 'not-editable' };
    if (typeof el.focus === 'function') el.focus();
    if (typeof el.select === 'function') el.select();
  }
  return {
    ok: true,
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    visible: visible,
    disabled: disabled,
    editable: editable
  };
}`;

export const CONTENT_SCRIPT = `function(args) {
  const root = document.documentElement;
  const html = root && typeof root.outerHTML === 'string' ? root.outerHTML : '';
  const maxChars = args.maxChars;
  if (html.length <= maxChars) return { html: html, truncated: false, length: html.length };
  return { html: html.slice(0, maxChars), truncated: true, length: html.length };
}`;

export interface ElementBox {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
  disabled: boolean;
  editable: boolean;
}

export function readElementResult(value: unknown): { ok: false; reason: AgentErrorCode; message: string } | { ok: true; box: ElementBox } | { ok: true; value: string } {
  if (!isRecord(value) || typeof value.ok !== 'boolean') {
    throw new AgentRuntimeError('page-script-failed', 'The page script returned an unexpected value');
  }
  if (!value.ok) {
    const reason = value.reason === 'not-found' || value.reason === 'invalid-selector' || value.reason === 'not-editable'
      ? value.reason
      : 'page-script-failed';
    const message = typeof value.message === 'string' ? value.message : reason;
    return { ok: false, reason, message };
  }
  if (typeof value.value === 'string') return { ok: true, value: value.value };
  const nums = [value.x, value.y, value.width, value.height];
  if (!nums.every((item) => typeof item === 'number' && Number.isFinite(item))) {
    throw new AgentRuntimeError('page-script-failed', 'The page script returned a non-numeric box');
  }
  return {
    ok: true,
    box: {
      x: value.x as number,
      y: value.y as number,
      width: value.width as number,
      height: value.height as number,
      visible: value.visible === true,
      disabled: value.disabled === true,
      editable: value.editable === true
    }
  };
}

export function assertClickable(box: ElementBox): void {
  if (!box.visible || box.disabled || box.width <= 0 || box.height <= 0) {
    throw new AgentRuntimeError(
      'not-actionable',
      'The element is missing a positive visible box or is disabled. Overlay hit-testing is not performed.'
    );
  }
}

export function assertEditable(box: ElementBox): void {
  if (!box.editable) {
    throw new AgentRuntimeError('not-editable', 'The element is not an input, textarea, or contentEditable node');
  }
}

export function readContentResult(value: unknown, maxChars: number): { html: string; truncated: boolean; length: number } {
  if (!isRecord(value) || typeof value.html !== 'string' || typeof value.length !== 'number') {
    throw new AgentRuntimeError('page-script-failed', 'The page script did not return HTML');
  }
  const truncated = value.truncated === true || value.html.length > maxChars || value.length > value.html.length;
  const html = value.html.length > maxChars ? value.html.slice(0, maxChars) : value.html;
  return { html, truncated, length: value.length };
}

// net::ERR_ABORTED. loadURL can report this for an about:blank start that
// was attached to the new promise and then replaced. It is not, by itself,
// the caller's navigation failing.
export const NET_ERR_ABORTED = -3;

export interface NavigationState {
  readonly phase: 'pending' | 'armed' | 'committed' | 'settled';
  readonly requestedUrl: string;
  readonly status: NavigationStatus;
  readonly outcome: NavigationOutcome | null;
}

export type NavigationOutcome =
  | { readonly type: 'success'; readonly url: string; readonly status: NavigationStatus }
  | { readonly type: 'failure'; readonly code: AgentErrorCode; readonly message: string };

export type NavigationEvent =
  | { type: 'start'; isMainFrame: boolean; isSameDocument: boolean; url: string }
  | { type: 'commit'; url: string; httpResponseCode: unknown; httpStatusText: unknown }
  | { type: 'finish-load'; url: string }
  | { type: 'fail'; errorCode: unknown; errorDescription: unknown; validatedURL: unknown; isMainFrame: unknown }
  | { type: 'load-rejected'; errno: number | null; message: string }
  | { type: 'timeout'; timeoutMs: number }
  | { type: 'abort' }
  | { type: 'destroyed' }
  | { type: 'crashed' };

export function createNavigation(requestedUrl: string): NavigationState {
  return {
    phase: 'pending',
    requestedUrl,
    status: httpStatusFromNavigateEvent(undefined, undefined),
    outcome: null
  };
}

function settleNavigation(state: NavigationState, code: AgentErrorCode, message: string): NavigationState {
  return { ...state, phase: 'settled', outcome: { type: 'failure', code, message } };
}

// Success requires a main-frame cross-document start, then a commit, then
// did-finish-load. A resolved loadURL promise is not an event and is not a
// status. Redirects update the commit. A second cross-document main-frame
// start fails the attempt instead of adopting the new load.
export function applyNavigationEvent(state: NavigationState, event: NavigationEvent): NavigationState {
  if (state.outcome) return state;
  switch (event.type) {
    case 'start': {
      if (!shouldArmNavigation(event)) return state;
      if (state.phase === 'pending') {
        return { ...state, phase: 'armed', status: httpStatusFromNavigateEvent(undefined, undefined) };
      }
      return settleNavigation(
        state,
        'navigation-failed',
        `A different main-frame navigation started for ${safeUrlForError(event.url)}`
      );
    }
    case 'commit': {
      if (state.phase !== 'armed' && state.phase !== 'committed') return state;
      return {
        ...state,
        phase: 'committed',
        status: httpStatusFromNavigateEvent(event.httpResponseCode, event.httpStatusText)
      };
    }
    case 'finish-load': {
      if (state.phase !== 'committed') return state;
      return {
        ...state,
        phase: 'settled',
        outcome: {
          type: 'success',
          url: event.url.length > 0 ? event.url : state.requestedUrl,
          status: state.status
        }
      };
    }
    case 'fail': {
      if (event.isMainFrame === false) return state;
      if (isForeignFailureUrl(event.validatedURL, state.requestedUrl)) return state;
      const code = typeof event.errorCode === 'number' && Number.isInteger(event.errorCode) ? event.errorCode : 0;
      // A pre-arm ERR_ABORTED is the about:blank promise race. A real abort
      // after arm, and any other code before arm (including ERR_INVALID_URL),
      // is a known failure and must not wait out the timeout.
      if (state.phase === 'pending' && code === NET_ERR_ABORTED) return state;
      const description = typeof event.errorDescription === 'string' && event.errorDescription.length > 0
        ? event.errorDescription
        : 'navigation failed';
      return settleNavigation(
        state,
        'navigation-failed',
        `${description} (${code}) for ${safeUrlForError(state.requestedUrl)}`
      );
    }
    case 'load-rejected': {
      if (event.errno === NET_ERR_ABORTED) return state;
      const detail = event.message.length > 0 ? event.message : 'loadURL failed';
      const suffix = event.errno === null ? '' : ` (${event.errno})`;
      return settleNavigation(
        state,
        'navigation-failed',
        `${detail}${suffix} for ${safeUrlForError(state.requestedUrl)}`
      );
    }
    case 'timeout':
      return settleNavigation(
        state,
        'timeout',
        `Navigation timed out after ${event.timeoutMs}ms for ${safeUrlForError(state.requestedUrl)}`
      );
    case 'abort':
      return settleNavigation(state, 'aborted', 'The navigation was aborted');
    case 'destroyed':
      return settleNavigation(state, 'destroyed', 'The page was destroyed during navigation');
    case 'crashed':
      return settleNavigation(state, 'crashed', 'The renderer crashed during navigation');
    default:
      return state;
  }
}

export function readLoadRejection(error: unknown): { errno: number | null; message: string } {
  if (!isRecord(error)) return { errno: null, message: 'loadURL failed' };
  const errno = typeof error.errno === 'number' && Number.isInteger(error.errno) ? error.errno : null;
  const message = typeof error.message === 'string' && error.message.length > 0 ? error.message : 'loadURL failed';
  return { errno, message };
}

export interface ListenerSet {
  add(unsubscribe: () => void): void;
  close(): void;
}

export function createListenerSet(): ListenerSet {
  const items: Array<() => void> = [];
  let closed = false;
  return {
    add(unsubscribe) {
      if (closed) {
        unsubscribe();
        return;
      }
      items.push(unsubscribe);
    },
    close() {
      if (closed) return;
      closed = true;
      const pending = items.splice(0);
      for (const unsubscribe of pending) unsubscribe();
    }
  };
}

export interface EffectGate {
  settled: boolean;
}

export function createEffectGate(): EffectGate {
  return { settled: false };
}

export function settleEffectGate(gate: EffectGate): void {
  gate.settled = true;
}

export function hostEffectAllowed(gate: EffectGate): boolean {
  return !gate.settled;
}

// Returns false when a timeout, abort, close, or crash already settled the
// operation. The action is then not run, so a late page-script result cannot
// send input.
export function performHostEffect(gate: EffectGate, effect: () => void): boolean {
  if (gate.settled) return false;
  effect();
  return true;
}

export const SNAPSHOT_DEFAULT_MAX_NODES = 2000;
export const SNAPSHOT_DEFAULT_TIMEOUT_MS = 10_000;
export const SNAPSHOT_MAX_NODES = 100_000;

export function assertSnapshotOptions(options: {
  maxNodes?: unknown;
  timeoutMs?: unknown;
  framePolicy?: unknown;
}): { maxNodes: number; timeoutMs: number; framePolicy: 'all' | 'same-origin' } {
  const maxNodes = options.maxNodes === undefined ? SNAPSHOT_DEFAULT_MAX_NODES : options.maxNodes;
  if (typeof maxNodes !== 'number' || !Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > SNAPSHOT_MAX_NODES) {
    throw new AgentRuntimeError('invalid-snapshot', `maxNodes must be an integer from 1 to ${SNAPSHOT_MAX_NODES}`);
  }
  const timeoutMs = assertTimeoutMs(options.timeoutMs, SNAPSHOT_DEFAULT_TIMEOUT_MS);
  const framePolicy = options.framePolicy === undefined ? 'all' : options.framePolicy;
  if (framePolicy !== 'all' && framePolicy !== 'same-origin') {
    throw new AgentRuntimeError('invalid-snapshot', "framePolicy must be 'all' or 'same-origin'");
  }
  return { maxNodes, timeoutMs, framePolicy };
}

export interface AXBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AXNode {
  id: number;
  role: string;
  name: string;
  parentId: number | null;
  childIds: number[];
  ignored: boolean;
  relativeBounds: AXBounds;
  offsetContainerId: number;
  hasTransform: boolean;
  boundsSpace: 'containing-node' | 'tree-root' | 'offset-container';
  // Null when a transform is present on the offset chain or the chain cycles.
  // Otherwise this is the sum of relative bounds, in the root's containing-node
  // space. It is not a screen point and it is not widget DIP.
  resolvedBounds: AXBounds | null;
}

export interface AXSnapshot {
  rootId: number | null;
  focusId: number | null;
  url: string;
  title: string;
  framePolicy: 'all' | 'same-origin';
  maxNodes: number;
  nodeCount: number;
  // True only when the returned node count reached maxNodes. Chromium can
  // also return a shorter tree when its snapshot timeout fires, without a
  // separate flag. This boolean does not detect that case.
  mayBeTruncated: boolean;
  stitching: 'chromium-ax-tree-combiner';
  inlineTextBoxes: 'stripped-by-chromium';
  crossFrameBounds: 'relative-chain-without-transforms';
  crossOriginStitch: 'linked-when-parent-tree-id-matches';
  nodes: AXNode[];
}

interface RawAXNode {
  id: number;
  role: string;
  name: string;
  childIds: number[];
  ignored: boolean;
  bounds: AXBounds;
  offsetContainerId: number;
  hasTransform: boolean;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function integer(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function readBounds(value: unknown): AXBounds | null {
  if (!isRecord(value)) return null;
  const x = finiteNumber(value.x);
  const y = finiteNumber(value.y);
  const width = finiteNumber(value.width);
  const height = finiteNumber(value.height);
  if (x === null || y === null || width === null || height === null) return null;
  return { x, y, width, height };
}

function snapshotFailed(message: string): AgentRuntimeError {
  return new AgentRuntimeError('snapshot-failed', message);
}

function addBounds(origin: AXBounds, local: AXBounds): AXBounds {
  return { x: origin.x + local.x, y: origin.y + local.y, width: local.width, height: local.height };
}

// Walks AXRelativeBounds the way Chromium describes them. An offset container
// of 0 means "relative to the tree root" for every node except the root,
// whose box is relative to a container outside this tree. Transforms are not
// flattened.
function resolveAXBounds(
  id: number,
  nodes: ReadonlyMap<number, RawAXNode>,
  rootId: number | null,
  memo: Map<number, AXBounds | null>,
  stack: Set<number>
): AXBounds | null {
  if (memo.has(id)) return memo.get(id) ?? null;
  const node = nodes.get(id);
  if (!node || stack.has(id) || node.hasTransform) {
    memo.set(id, null);
    return null;
  }
  stack.add(id);
  let resolved: AXBounds | null = null;
  if (node.offsetContainerId > 0) {
    const origin = resolveAXBounds(node.offsetContainerId, nodes, rootId, memo, stack);
    if (origin) resolved = addBounds(origin, node.bounds);
  } else if (rootId !== null && id !== rootId) {
    const origin = resolveAXBounds(rootId, nodes, rootId, memo, stack);
    if (origin) resolved = addBounds(origin, node.bounds);
  } else {
    resolved = { x: node.bounds.x, y: node.bounds.y, width: node.bounds.width, height: node.bounds.height };
  }
  stack.delete(id);
  memo.set(id, resolved);
  return resolved;
}

export function assembleAXSnapshot(value: unknown): AXSnapshot {
  if (!isRecord(value)) throw snapshotFailed('Accessibility snapshot was not an object');
  const framePolicy = value.framePolicy === 'all' || value.framePolicy === 'same-origin' ? value.framePolicy : null;
  if (!framePolicy) throw snapshotFailed("framePolicy must be 'all' or 'same-origin'");
  const maxNodes = integer(value.maxNodes);
  if (maxNodes === null || maxNodes < 1) throw snapshotFailed('maxNodes must be a positive integer');
  if (typeof value.url !== 'string' || typeof value.title !== 'string') {
    throw snapshotFailed('url and title must be strings');
  }
  const rootId = value.rootId === null || value.rootId === 0 ? null : integer(value.rootId);
  if (value.rootId !== null && value.rootId !== 0 && rootId === null) throw snapshotFailed('rootId must be an integer or null');
  const focusId = value.focusId === null || value.focusId === 0 ? null : integer(value.focusId);
  if (value.focusId !== null && value.focusId !== 0 && focusId === null) throw snapshotFailed('focusId must be an integer or null');
  if (!Array.isArray(value.nodes)) throw snapshotFailed('nodes must be an array');

  const rawNodes: RawAXNode[] = [];
  const byId = new Map<number, RawAXNode>();
  for (const entry of value.nodes) {
    if (!isRecord(entry)) throw snapshotFailed('A snapshot node was not an object');
    const id = integer(entry.id);
    const bounds = readBounds(entry.bounds);
    const offsetContainerId = integer(entry.offsetContainerId);
    if (id === null || bounds === null || offsetContainerId === null) {
      throw snapshotFailed('A snapshot node is missing id, bounds, or offsetContainerId');
    }
    if (typeof entry.role !== 'string' || typeof entry.name !== 'string' || typeof entry.ignored !== 'boolean' || typeof entry.hasTransform !== 'boolean') {
      throw snapshotFailed('A snapshot node is missing role, name, ignored, or hasTransform');
    }
    if (!Array.isArray(entry.childIds) || entry.childIds.some((child) => integer(child) === null)) {
      throw snapshotFailed('childIds must be an array of integers');
    }
    if (byId.has(id)) throw snapshotFailed(`Duplicate accessibility node id ${id}`);
    const node: RawAXNode = {
      id,
      role: entry.role,
      name: entry.name,
      childIds: entry.childIds as number[],
      ignored: entry.ignored,
      bounds,
      offsetContainerId,
      hasTransform: entry.hasTransform
    };
    rawNodes.push(node);
    byId.set(id, node);
  }

  const parentOf = new Map<number, number>();
  for (const node of rawNodes) {
    for (const childId of node.childIds) {
      if (!parentOf.has(childId)) parentOf.set(childId, node.id);
    }
  }
  const memo = new Map<number, AXBounds | null>();
  const nodes: AXNode[] = rawNodes.map((node) => {
    let boundsSpace: AXNode['boundsSpace'];
    if (node.offsetContainerId > 0) boundsSpace = 'offset-container';
    else if (rootId !== null && node.id !== rootId) boundsSpace = 'tree-root';
    else boundsSpace = 'containing-node';
    return {
      id: node.id,
      role: node.role,
      name: node.name,
      parentId: parentOf.get(node.id) ?? null,
      childIds: [...node.childIds],
      ignored: node.ignored,
      relativeBounds: node.bounds,
      offsetContainerId: node.offsetContainerId,
      hasTransform: node.hasTransform,
      boundsSpace,
      resolvedBounds: resolveAXBounds(node.id, byId, rootId, memo, new Set())
    };
  });

  return {
    rootId,
    focusId,
    url: value.url,
    title: value.title,
    framePolicy,
    maxNodes,
    nodeCount: nodes.length,
    mayBeTruncated: nodes.length >= maxNodes,
    stitching: 'chromium-ax-tree-combiner',
    inlineTextBoxes: 'stripped-by-chromium',
    crossFrameBounds: 'relative-chain-without-transforms',
    crossOriginStitch: 'linked-when-parent-tree-id-matches',
    nodes
  };
}

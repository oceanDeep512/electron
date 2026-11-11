/* oxlint-disable */

import { agentRuntime, type Session, type WebContents } from 'electron/main';

const flags = agentRuntime.checkpoint;
const controlPlane: boolean = flags.controlPlane;
const accessibility: boolean = flags.accessibilitySnapshot;
const responseBodies: boolean = flags.responseBodyObservation;
const personaUserAgent: boolean = flags.nativePersona.userAgent;
const personaScreen: boolean = flags.nativePersona.screen;
const personaWebGL: boolean = flags.nativePersona.webgl;
const personaWebGPU: boolean = flags.nativePersona.webgpu;
const personaCanvas: boolean = flags.nativePersona.canvas;
const personaAudio: boolean = flags.nativePersona.audio;
const personaWebRTC: boolean = flags.nativePersona.webrtc;
const personaFonts: boolean = flags.nativePersona.fonts;
const webSocketMessages: boolean = flags.webSocketMessageObservation;
void controlPlane;
void accessibility;
void responseBodies;
void personaUserAgent;
void personaScreen;
void personaWebGL;
void personaWebGPU;
void personaCanvas;
void personaAudio;
void personaWebRTC;
void personaFonts;
void webSocketMessages;

const runtimeSession = agentRuntime.createSession({ partition: 'persist:agent-smoke' });
const page = runtimeSession.createPage({ show: false, width: 800, height: 600 });
const contents: WebContents = page.webContents;
const storage: string = runtimeSession.storagePartition;
void storage;

const stop = runtimeSession.observeResponses({
  urls: ['https://example.com/*'],
  maxBytesPerResponse: 1024,
  maxInFlight: 2,
  maxAggregateBytes: 4096
}, (event) => {
  const id: string = event.requestId;
  if (event.phase === 'redirect') {
    const destination: string = event.redirectUrl;
    const maybeBody: Buffer | null = event.body;
    void destination;
    void maybeBody;
  }
  if (event.phase === 'completed' && event.body) {
    const exact: number = event.body[0];
    void exact;
  }
  void id;
  void event.truncated;
  void event.skipReason;
  void event.networkDecoded;
  void event.queueDropped;
});
stop();

const stopSockets = runtimeSession.observeWebSockets({
  urls: ['ws://127.0.0.1/*'],
  maxBytesPerMessage: 1024,
  maxInFlight: 2,
  maxAggregateBytes: 4096
}, (event) => {
  if (event.phase === 'message' && event.opcode === 'text' && event.text !== null) {
    const text: string = event.text;
    void text;
  }
  if (event.phase === 'message' && event.body) {
    const exact: number = event.body[0];
    void exact;
  }
  void event.direction;
  void event.truncated;
  void event.wireCompressed;
  void event.queueDropped;
});
stopSockets();

const electronSession: Session = runtimeSession.session;
electronSession.setResponseBodyObservation(null);
electronSession.setResponseBodyObservation((event) => {
  void event.phase;
}, {
  urls: ['https://example.com/'],
  maxBytesPerResponse: 32
});
electronSession.updateResponseBodyObservationLimits({ maxBytesPerResponse: 64 });
electronSession.setWebSocketMessageObservation(null);
electronSession.setWebSocketMessageObservation((event) => {
  void event.phase;
}, { maxBytesPerMessage: 32 });
electronSession.updateWebSocketMessageObservationLimits({ maxBytesPerMessage: 64 });
electronSession.setAgentPersona({
  id: 'smoke',
  seed: 'seed-1',
  userAgent: 'Mozilla/5.0 AgentRuntime',
  acceptLanguages: 'zh-CN',
  timezone: 'Asia/Shanghai',
  hardwareConcurrency: 8,
  deviceMemory: 8,
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
  formFactors: ['Desktop'],
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
  webrtcIpHandlingPolicy: 'default_public_interface_only'
});

void contents.captureAccessibilitySnapshot({ maxNodes: 10, timeoutMs: 1000, framePolicy: 'same-origin' });
void page.snapshot({ maxNodes: 10, framePolicy: 'all' });

// @ts-expect-error maxBytesPerResponse is an integer, not a string
runtimeSession.observeResponses({ maxBytesPerResponse: 'nope' }, () => {});

// @ts-expect-error the listener is required
runtimeSession.observeResponses({});

// @ts-expect-error maxBytesPerMessage is an integer, not a string
runtimeSession.observeWebSockets({ maxBytesPerMessage: 'nope' }, () => {});

// @ts-expect-error the listener is required
runtimeSession.observeWebSockets({});

// @ts-expect-error a missing partition is rejected by the signature
agentRuntime.createSession({});

/* oxlint-disable */

import { agentRuntime, type Session, type WebContents } from 'electron/main';

const flags = agentRuntime.checkpoint;
const controlPlane: boolean = flags.controlPlane;
const accessibility: boolean = flags.accessibilitySnapshot;
const responseBodies: boolean = flags.responseBodyObservation;
const personaOff: boolean = flags.nativePersona;
const webSocketOff: boolean = flags.webSocketMessageObservation;
void controlPlane;
void accessibility;
void responseBodies;
void personaOff;
void webSocketOff;

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
});
stop();

const electronSession: Session = runtimeSession.session;
electronSession.setResponseBodyObservation(null);
electronSession.setResponseBodyObservation((event) => {
  void event.phase;
}, {
  urls: ['https://example.com/'],
  maxBytesPerResponse: 32
});

void contents.captureAccessibilitySnapshot({ maxNodes: 10, timeoutMs: 1000, framePolicy: 'same-origin' });
void page.snapshot({ maxNodes: 10, framePolicy: 'all' });

// @ts-expect-error maxBytesPerResponse is an integer, not a string
runtimeSession.observeResponses({ maxBytesPerResponse: 'nope' }, () => {});

// @ts-expect-error the listener is required
runtimeSession.observeResponses({});

// @ts-expect-error a missing partition is rejected by the signature
agentRuntime.createSession({});

# Agent Runtime

This page records the persona checkpoint of the agent runtime. The control plane, accessibility snapshots, HTTP response bodies, and page WebSocket messages remain. A persona can apply user agent, client hints metadata, accept languages, timezone, hardware concurrency, device memory, screen metrics including resolution, color, optional color-index, and optional HDR media queries, WebGL and WebGPU identifiers, canvas and audio readback, WebRTC IP handling, and `fontPolicy: "core"`. WebSocket observation includes shared workers, service workers, `net.WebSocket` on that session, and page sockets that also pass through an extension proxy. The C++ and the Chromium patches are source only: they have not been compiled or run.

## Status of this checkpoint

| Area | Status |
| --- | --- |
| Design record and baseline pin | Written on this page |
| `agentRuntime` session and page control plane | Implemented in the main process |
| Public docs and generated TypeScript surface | `docs/api/agent-runtime.md` and `webContents.captureAccessibilitySnapshot` |
| Navigation, locator, and input without CDP | Implemented, with the boundaries below |
| Persona config validation | Implemented as a pure check |
| Applying a fingerprint persona | User agent, client hints, accept languages, timezone, hardware, screen metrics, WebGL and WebGPU identifiers, canvas and audio readback, WebRTC IP handling, and `fontPolicy: "core"` are wired in source. Source only, not compiled |
| Accessibility snapshot | Wired to `WebContents::RequestAXTreeSnapshot`. Source only, not compiled |
| HTTP response body observation | Wired through `session.observeResponses()`. Source only, not compiled |
| WebSocket message observation | Wired through `session.observeWebSockets()` for page and dedicated-worker sockets. Source only, not compiled |

`electron.agentRuntime.checkpoint` exposes the same flags at runtime. `accessibilitySnapshot`, `responseBodyObservation`, and `webSocketMessageObservation` are true. `nativePersona` is an object. User agent, client hints, accept languages, timezone, hardware concurrency, device memory, screen, WebGL, WebGPU, canvas, audio, WebRTC, and fonts are true.

## Pinned baseline

The fork baseline is commit `ef2710fa6c10fe56365a9949fa783d26ca1499e5` on `agentic-runtime-v1`.

That commit matches Electron `47.0.0-nightly.20261106`. `DEPS` pins Chromium `159.0.8140.0` and Node `v26.13.0`. This checkpoint does not move the pin, rebase the branch, or sync a Chromium checkout.

Package metadata in this fork still says `0.0.0-development` because the fork has no release tags. The nightly version above comes from the Electron release schedule for that commit, not from `git describe`.

## Control-plane API

The module is `agentRuntime`, registered from `lib/browser/api/module-list.ts` and loaded through the normal browser bundle. Stock Electron modules are unchanged when this API is not called.

```ts
const runtime = electron.agentRuntime;

const session = runtime.createSession({ partition: 'alpha' });
const page = session.createPage({ show: false, width: 800, height: 600 });
const result = await page.goto('https://example.test/');
await page.locator('#field').fill('hello');
await page.locator('#go').click();
const html = await page.content();
page.close();
session.close();
```

`createSession` returns the same object when called again for an open, compatible partition. `session.session` is the existing Electron `Session`. `session.personaApplied` is false and `session.personaId` is null.

`createPage` without `webContents` opens a hidden `BrowserWindow` unless `show` is true. Its webPreferences set `sandbox`, `contextIsolation`, and `webSecurity` to true, and set `nodeIntegration`, `nodeIntegrationInWorker`, and `nodeIntegrationInSubFrames` to false. The window partition is the session storage partition. No preload is injected.

Passing an existing `webContents` to `createPage` adopts that page. It does not change webPreferences, visibility, size, or preload. `show`, `width`, and `height` are rejected together with `webContents`. The adopted `WebContents` must already use this session; otherwise the call throws `partition-mismatch` and leaves the page untouched. `page.close()` on an adopted page only drops the handle. `page.close()` on a page this API created destroys that window.

`session.close()` closes those handles and drops the in-memory session record. It does not delete the Chromium storage partition. A later `createSession` for the same partition creates a new handle around the same Electron session.

`page.snapshot()` is the accessibility API. There is no `observe` method. Debugger and CDP are not used. `webContents.debugger.attach` is not called.

Page scripts run in isolated world `1001`. World `0` is the page world. World `999` is Electron context isolation. Selector text and script arguments are passed with `JSON.stringify`. Fill text is sent with `webContents.insertText` and is not concatenated into JavaScript source.

At most four operations wait on one page. A fifth fails with `busy`. A timeout stops waiting and settles an effect gate before the caller is rejected. `executeJavaScriptInIsolatedWorld` itself cannot be cancelled, so a timed-out script may still finish in the page. The slot is released so the next operation can start. `click`, `fill`, and `press` call `performHostEffect` and do not send input after that gate is settled. Navigation timeout and abort call `webContents.stop()` only after the navigation outcome is already timeout or aborted.

The registry that remembers open sessions is main-process bookkeeping. It is not a process-wide Chromium preference, user-agent override, timezone, or command-line switch. Per-session data stays on the partition's `Session` and on the handle.

## Partitions and persona

`partition` is required and must be a non-empty string. An empty string is rejected so this API never attaches to the default session. The name is one to 128 characters of letters, digits, `.`, `_`, or `-`, and must not contain `..` or a repeated `persist:` prefix.

`persist: true` stores `persist:` plus the name. `persist: false` stores the bare name and conflicts with a `persist:` prefix. When `persist` is omitted, a `persist:` prefix means persistent storage and a bare name means in-memory storage.

`validatePersona` only checks the shape. A successful result does not by itself change a renderer. `createSession` applies a valid persona after `session.fromPartition` and before any page. `persona: null` is invalid. Omit the property to create a normal session. `fontPolicy: "core"` is valid and is applied with the other surfaces.

`personaStorageId` is the canonical JSON of a validated persona. Two open handles may share a partition only when persistence matches and the persona id matches. A different id throws `partition-conflict`. The native side also refuses a second id, and it refuses an apply after any page, renderer process, or running service worker exists in that partition. The renderer check walks `RenderProcessHost::AllHostsIterator`, including a spare renderer that already belongs to the partition, and `StoragePartition::GetServiceWorkerContext()->GetRunningServiceWorkerInfos()`.

## Navigation

`page.goto` accepts only `http:`, `https:`, `file:`, and `data:` URLs. A second `goto` while one is in progress fails with `navigation-in-progress`. Locator, `content`, and `snapshot` calls also fail with that code until the navigation settles. Destroyed, crashed, and closed pages reject new work. `AbortSignal` and the timeout stop the load.

HTTP status is copied from `did-navigate` or a main-frame `did-frame-navigate` only after this call has armed on its own main-frame cross-document `did-start-navigation`. Codes outside 100 through 599, including the non-HTTP value `-1`, become `httpStatus: null` and `httpStatusSource: "unavailable"`. A resolved `loadURL` promise is not success and is not a status. This API never substitutes 200. `data:` and `file:` navigations therefore report an unavailable status when they commit with a non-HTTP code.

The initial `BrowserWindow` document is `about:blank`. Those starts, commits, finishes, and `about:` failures are ignored. `net::ERR_ABORTED` (`-3`) before arm is ignored, because `LoadURL` can attribute that rejection to the initial blank load and then continue the real navigation. Any other `did-fail-load` before arm, including `ERR_INVALID_URL`, fails immediately. A `loadURL` rejection other than `-3`, including `ERR_FAILED` (`-2`) from `DidStopLoading`, also fails immediately. Same-document starts and subframe starts are ignored. A server redirect is not a second start; the later commit carries the final URL and the final HTTP status. A second cross-document main-frame start, including a reload or `webContents.loadURL` from outside this call, fails the attempt and does not report that other load as success. Success still requires arm, then commit, then `did-finish-load`. The result URL is `webContents.getURL()` at finish.

Error strings pass the URL through `safeUrlForError`, which removes username and password.

## Locators and input

Selectors run in the main frame only. An element inside an iframe is not found. The page script reads `querySelector`, layout, and `getComputedStyle`. It does not test whether another element covers the target. `click` requires a positive visible box and a control that is not disabled.

The click point is the CSS box center multiplied by `webContents.zoomFactor`, then rounded. `deviceScaleFactor` is not applied. Iframe offsets are not applied. These coordinates are a DIP assumption and have not been confirmed in a built Electron.

`click` and `fill` call `BrowserWindow.focus()` and `webContents.focus()` when a window exists. Electron documents that `sendInputEvent` needs the containing window to be focused. This checkpoint does not claim the operating system focus change succeeded. The input spec uses a shown window and the serial tag for that reason. `sendInputEvent` is still invoked after the focus calls.

`press` accepts a single character or a short list of named keys such as Enter, Tab, Escape, arrows, and Space. Modifier chords are rejected. A one-character key keeps its original case in the char event. Enter and Tab send key down and key up only, because a char event for those accelerator names would insert the words Return and Tab. Space does send a char event. Electron maps that name to the space character.

`fill` is limited to 100000 characters and rejects NUL. `content` defaults to 200000 characters and refuses more than 1000000. The main process truncates again if the page returns a longer string.

## Accessibility snapshot

`page.snapshot()` calls `webContents.captureAccessibilitySnapshot()`, which calls `content::WebContents::RequestAXTreeSnapshot` on Chromium `159.0.8140.0`. The mode is `kWebContents | kExtendedProperties`. `kNativeAPIs` is not set. `app.setAccessibilitySupportEnabled` is not called. The snapshot implementation in Chromium strips inline text boxes. The callback copies the `AXTreeUpdate` into a dictionary and resolves a `gin_helper::Promise`. A weak pointer drops the callback if the native lifecycle is gone. The promise is rejected on destroy, renderer crash, and cross-document main-frame navigation other than `about:`. A second snapshot while one request is stored rejects as already in progress. A JavaScript timeout can therefore leave that native request busy until Chromium's callback returns; the late tree is not given to the caller who already timed out.

`framePolicy: "all"` is `AXTreeSnapshotPolicy::kAll`. `framePolicy: "same-origin"` is `kSameOriginDirectDescendants`. Chromium's `AXTreeCombiner` renumbers ids and links a child tree only when that tree's `parent_tree_id` matches and it has nodes. Frames the snapshotter skipped, unknown tree ids, and parent mismatches are absent. This is Chromium's stitch, not a DOM walk, and it is not a claim of complete cross-frame pixel fidelity.

`resolvedBounds` adds `AXRelativeBounds` along the offset-container chain. An offset of `0` means relative to the tree root, except for the root, whose box is relative to a container outside the tree. A transform or a cycle makes `resolvedBounds` null. Those numbers are not screen coordinates and not widget DIP.

`mayBeTruncated` is true only when the node count reached `maxNodes`. Chromium can also return a shorter tree when its own timeout fires, and that case is not separately flagged.

## HTTP response bodies

`session.observeResponses()` validates the filter and limits, then installs one native listener on that session's `Session`. Extra JavaScript listeners share that listener. The native side is `session.setResponseBodyObservation()`. With no listener, `InterceptState::response_body_enabled()` is false and both the URL loader gate and `ProxyingURLLoaderFactory` keep the existing direct pipe.

A matching `http` or `https` request is claimed once. The gate's direct branch and the proxy's direct branch insert `ResponseBodyURLLoader` only after that claim. `kObserve` tees inside `ObservedURLLoader`. `kProxy` tees when `InProgressRequest` forwards `current_body_` to the renderer. A request is not teed in two of those places. Redirects forward `OnReceiveRedirect` and emit `phase: "redirect"` with no body.

The tee reads the network consumer only when the renderer producer accepts bytes. One 16 KiB pending chunk is the only userspace forwarding buffer. Capture stops at `maxBytesPerResponse` and at the aggregate cap, sets `truncated` or `skipReason`, and keeps forwarding. Creating the pipe, filling the in-flight set, or filling the aggregate does not fail the request. The UI queue holds at most 64 events. A discarded event releases its bytes immediately, and the next delivered event reports the count in `queueDropped`. Installing or replacing the listener bumps the generation, so a tee from the previous subscription does not deliver into the new one. `updateResponseBodyObservationLimits` does not bump it. Clearing observation, including session close, bumps the generation, drops queued payloads, and leaves a tee that already started forwarding the page body on that path.

Delivery runs on the UI thread. It does not require an ambient current context. It enters `JavascriptEnvironment::GetIsolate()`, then the function's creation context, with `gin_helper::Locker`, `v8::Isolate::Scope`, `gin_helper::NodeEntryScope`, and `v8::MicrotasksScope`, which is the same shape as `gin_helper::V8FunctionInvoker` and `NodeStreamLoader`. A disposed creation context skips that call. The listener is not invoked off the UI thread.

Chromium 159 `services/network/url_loader.cc` fills the data pipe from `URLRequest::Read`. `URLResponseHead.client_side_content_decoding_types` is non-empty only when the request set client-side content decoding. Ordinary page and `fetch` loads do not, so the observed bytes are the filtered body, including gzip, deflate, and brotli decoded by the network stack. `networkDecoded` reports that field. The tee does not decode or re-encode.

Not observed, and not claimed:

*   `file:` and custom protocols. WebSocket messages use the separate socket path below.
*   The extensions early return in `ElectronBrowserClient::WillCreateURLLoaderFactory` when the extensions WebRequest API proxies the factory, Electron has no webRequest listener, and there is no protocol intercept handler. That path returns before Electron's gate and proxy.
*   CORS preflight `InProgressRequest` objects.

The listener is intentionally given the body. Nothing in this path writes the body, cookies, or authorization headers to a log or to disk.

## WebSocket messages

`session.observeWebSockets()` validates the filter and limits, then installs one native listener. Extra JavaScript listeners share it through `updateWebSocketMessageObservationLimits`. With no listener, `WillInterceptWebSocket` stays on its previous answer, so a page with no webRequest listener is not proxied just to observe messages.

Chromium 159 `WebSocketConnectorImpl::Connect` calls `WillInterceptWebSocket(frame)` when the connector has a frame. Pages and dedicated workers have one, and dedicated workers carry the creator document's frame. Shared workers and service workers use `frame_routing_id` `kRoutingIdNone`, so `frame` is null. `patches/chromium/agent_runtime_worker_websocket.patch` adds `WillInterceptWorkerWebSocket(RenderProcessHost*)` and `CreateWorkerWebSocket`. The connector calls those when the routing id is none and the renderer process is still alive. Electron returns true only when that process's `BrowserContext` has WebSocket observation on, then `ProxyingWebSocket` runs with `kRoutingIdNone` and that context. The default Chromium implementations return false and `NOTREACHED`.

`net.WebSocket` calls `NetworkContext::CreateWebSocket` directly. `WebSocketWrapper::OnConnectionEstablished` passes those Mojo ends through `ObserveWebSocketConnection` before it binds them, and `OnFailure` emits `failed`. The session is the `BrowserContext` given to `net.WebSocket`. When observation is on for a page and an extension `MayHaveProxies`, `CreateWebSocket` no longer returns early. `ProxyingWebSocket` stays the outer hop, and its factory calls `WebRequestAPI::ProxyWebSocket` with the network factory wrapped so extension headers win on a duplicate name and the extension auth handler is used when it is valid. The extension method requires a `RenderFrameHost`, so shared and service workers are not sent through it. When observation is off and Electron has no webRequest listener, the extension proxy remains the only hop.

After the handshake, `ProxyingWebSocket` no longer drops the Mojo endpoints when the connection is claimed. `WebSocketMessageForwarder` binds both `WebSocket` and `WebSocketClient` and tees both data pipes. `OnDataFrame` is forwarded before the corresponding bytes are copied, matching `services/network/websocket.cc`, which sends the frame message and then writes the pipe. The renderer writes `SendMessage` and then the bytes, matching `websocket_channel_impl.cc`. The forwarder reads a pipe only up to the length those messages announced, and only when the other side's pipe accepts the write. While one data frame still has unread bytes, the message receiver is paused, the same way `net.WebSocket` pauses `client_receiver_` until that frame's bytes are drained. The next frame stays in the Mojo pipe. Lengths are not dropped, and the deque holds at most the one frame already accepted. Resume is posted so a burst does not nest dispatch on the stack. `CreateDataPipe` has to return `MOJO_RESULT_OK` and both ends have to be valid before any watcher is armed. Shutdown cancels watchers, clears disconnect handlers, resets the endpoints, and only then drops the self-ref. A watcher callback holds its own `scoped_refptr`, so that reset cannot destroy the forwarder until the callback returns. Ping and pong never appear on `WebSocketClient`; they are answered inside `net::WebSocketChannel` and this API does not invent them.

Incoming fragmentation follows `fin` and `WebSocketMessageType`. A message is emitted when the final frame's bytes have been forwarded. Outgoing `SendMessage` is one message, `TEXT` or `BINARY`. `text` is set only when that complete message is valid UTF-8. Truncation keeps forwarding the rest of the message. Closing mid-message emits the partial bytes with `truncated` and then `closed` or `failed`. Replacing the listener bumps the generation. Clearing it does too, and an in-progress forwarder keeps copying pipes after it stops emitting.

`wireCompressed` is true when the handshake extensions contain `permessage-deflate`. `WebSocketDeflateStream` inflates before `WebSocketChannel::HandleDataFrame`, and the renderer writes uncompressed bytes that the network service deflates on send. The observed payload is therefore the logical message. That reading is from the pinned sources above. It is not runtime-proven.

## Persona surfaces in this checkpoint

`fontPolicy: "core"` is applied with the other fields. `webrtcIpHandlingPolicy: "default"` and an omitted screen, WebGL, or WebGPU object leave those particular values on Chromium's real results. The seed is still installed, so canvas and audio readback are perturbed for every applied persona.

The apply runs after `session.fromPartition` and before any page. It sets `NetworkContext::SetUserAgent` and `SetAcceptLanguage`, stores `blink::UserAgentMetadata` on the partition, and `WebContents::SetUserAgent` passes that metadata as `ua_metadata_override`. Chromium uses that override for the document user agent, `navigator.userAgentData`, and `Sec-CH-UA*`. `dedicated_worker.cc` at the pin copies `execution_context->UserAgent()` and `GetUserAgentMetadata()` into the worker, so a dedicated worker follows the document. Shared workers (`shared_worker_host.cc`) and service workers (`service_worker_version.cc`) call `ContentBrowserClient::GetUserAgent()` and `GetUserAgentMetadata()`. `patches/chromium/agent_persona_worker_user_agent.patch` adds `OverrideUserAgentForBrowserContext` and calls it with the worker's `BrowserContext`. Electron fills the user agent and metadata from the persona.

Timezone is checked with `icu::TimeZone::createTimeZone` in the browser and is not installed as the browser-process default. Renderer processes for that partition receive the persona command-line switches from `AppendExtraCommandLineSwitches`. `RendererClientBase::RenderThreadStarted` calls `blink::TimeZoneController::SetTimeZoneOverride` and keeps the returned handle so the destructor does not clear it. The controller notifies V8 and worker threads in that process.

A spare renderer is refused for a persona partition because it would have been launched without those switches. Chromium `159.0.8140.0` `SpareProcessRefusedByEmbedderReason` is `DefaultDisabled`, `NoProfile`, `TopFrameChromeWebUI`, `InstantRendererForNewTabPage`, `ExtensionProcess`, `JitDisabled`, `V8OptimizationsDisabled`, or `DisallowV8FeatureFlagOverrides`. None of those name a persona. The refusal uses `DefaultDisabled`, the same general embedder value this method already uses when spares are turned off. Adding an enum value would also require a metrics XML change, and no existing bucket is more accurate.

Renderer switches, present only when that field is set:

*   `--electron-agent-timezone`
*   `--electron-agent-hardware-concurrency`
*   `--electron-agent-device-memory`
*   `--electron-agent-screen`, six comma-separated numbers: width, height, availWidth, availHeight, colorDepth, deviceScaleFactor
*   `--electron-agent-webgl-vendor` and `--electron-agent-webgl-renderer`
*   `--electron-agent-webgpu-vendor`, `--electron-agent-webgpu-architecture`, `--electron-agent-webgpu-device`, and `--electron-agent-webgpu-description`
*   `--electron-agent-canvas-seed` and `--electron-agent-audio-seed`, both the persona seed
*   `--electron-agent-font-policy=core`, only when `fontPolicy` is `core`
*   `--electron-agent-color-index`, only when `screen.colorIndex` is set
*   `--electron-agent-hdr=0` or `1`, only when `screen.highDynamicRange` is set

`hardwareConcurrency` and `deviceMemory` are read in Blink by `patches/chromium/agent_persona_renderer_hardware_overrides.patch`. Screen metrics are read by `patches/chromium/agent_persona_screen_metrics.patch` and `patches/chromium/agent_persona_media_query_screen.patch`. `Screen::GetRect` and `Screen::colorDepth` use the switch. `MediaValues::CalculateDeviceWidth` and `CalculateDeviceHeight` use the same width and height, including the physical-pixel quirk, so `matchMedia` `device-width` and `device-height` follow `screen.width` and `screen.height`. `window.devicePixelRatio` and `MediaValues::CalculateDevicePixelRatio` return the persona scale, so `(resolution)`, `(min-resolution)`, `(max-resolution)`, and the prefixed device-pixel-ratio features follow it. `LocalFrame::DevicePixelRatio()` is not changed, so layout, canvas backing-store scale, and offscreen rendering keep the real scale. `CalculateColorBitsPerComponent` derives CSS `color` from the persona `colorDepth`: 48 is 16, 30 is 10, 16 is 5, and 32, 24, and 8 are 8. `(color-index)` stays 0 unless `screen.colorIndex` is set. `patches/chromium/agent_persona_media_query_hdr.patch` then uses that integer in `ColorIndexMediaFeatureEval`, including the boolean form. `(dynamic-range)` and `(video-dynamic-range)` stay on `display_color_spaces.SupportsHDR()` unless `screen.highDynamicRange` is set. `true` forces `high` to match and `false` forces it not to. `standard` still matches.

WebGL and WebGPU identifiers are `patches/chromium/agent_persona_webgl_webgpu_identifiers.patch`. `WebGLRenderingContextBase::getParameter` returns the persona vendor for both `GL_VENDOR` and `UNMASKED_VENDOR_WEBGL`, and the persona renderer for both `GL_RENDERER` and `UNMASKED_RENDERER_WEBGL`. The extension-disabled error path is unchanged. `GPUAdapterInfo` overrides vendor, architecture, device, and description. Those strings are built once in a function-local `base::NoDestructor`. `subgroupMinSize` and the other limit getters stay on the real adapter.

Canvas readback is `patches/chromium/agent_persona_canvas_readback.patch`. `ImageDataBuffer::EncodeImage` and `ToDataURL` copy the pixmap and perturb the copy. The software `peekPixels` path aliases the displayed bitmap, so that memory is not written. `HTMLCanvasElement` `toDataURL` uses `ToDataURL`. `toBlob` and OffscreenCanvas `convertToBlob` both reach `CanvasAsyncBlobCreator::EncodeImage`, which calls `ImageDataBuffer::EncodeImage`. `getImageData` perturbs the new `ImageData` after `readPixels`, including the context-lost and out-of-bounds buffers. `putImageData` is a display write and is not perturbed. Every 64th byte moves by one and wraps at 0 and 255. The change is a function of the seed, the index, and the original byte.

Audio readback is `patches/chromium/agent_persona_audio_readback.patch`. `OfflineAudioContext::OnChunkRendered` perturbs the result once, before `Resolve`, through `getChannelData`. `AudioBuffer` records that with `agent_readback_perturbed_`, so a later render of the same buffer is not shifted again. Later `getChannelData` and `copyFromChannel` see that same channel. Live `AudioBuffer` objects are not perturbed on every read. `AnalyserNode` perturbs the array returned by `getFloatFrequencyData`, `getByteFrequencyData`, `getFloatTimeDomainData`, and `getByteTimeDomainData` after the handler fills it. Float samples move by `1e-7`. Byte samples move by one. The analyser node itself is not modified.

WebRTC has no Chromium patch. `ElectronBrowserClient::OverrideWebPreferences` writes `blink::RendererPreferences::webrtc_ip_handling_policy` from the persona after the guest preference override, so a page created later still receives it. `WebContents::InitWithSessionAndOptions` calls the existing `SetWebRTCIPHandlingPolicy` after `accept_languages` is assigned. `default` and an empty policy skip both writes.

Dedicated workers share the document renderer, so they see the same switches. Shared-worker and service-worker processes are renderer processes of the same `BrowserContext`, and `AppendExtraCommandLineSwitches` adds the switches when that process is created after the persona. Workers do not have `window.screen`. WebRTC preferences are per `WebContents`, not a worker command line.

`fontPolicy: "core"` is `patches/chromium/agent_persona_font_core.patch`. The switch is read in the renderer. Named families other than Arial, Courier New, Georgia, Times New Roman, Trebuchet MS, and Verdana do not match in `CSSFontSelector::GetFontData`, so layout and `measureText` fall through to the next family or the generic. `FontCache::IsPlatformFamilyMatchAvailable` and `IsPlatformFontUniqueNameMatchAvailable` reject other names, and `local()` unique lookup returns null for them. `FontFaceSet::check` returns false for a non-generic family that is not available and has no downloaded face. `queryLocalFonts` drops enumeration entries whose family is outside the list. `FallbackFontForCharacter` does not scan the installed fonts; it uses `GetLastResortFallbackFont`. Generic families still resolve through the platform settings. The six core names use the host face when that face is installed, so their presence and widths can differ by operating system. No font file is bundled. The last-resort face is still a host font, so a missing glyph's width can differ by operating system. PostScript names that are not one of the six published family names do not match `local()`.

## Explicitly not implemented

The following stay out of this checkpoint.

*   Identical font metrics across Linux, Windows, and macOS. The core policy blocks families outside the published list. It does not ship a font file, and the last-resort face is still the host's.
*   `local()` matching a PostScript name that is not one of the six published family names.
*   Sending a shared-worker or service-worker socket through `ProxyWebSocket`. That method takes a `RenderFrameHost`, and those connectors have none.
*   Finch, Widevine spoofing, and TLS or JA3 changes. None of those are part of the persona.
*   Any claim that a persona is undetectable, or that codecs and Widevine are something other than what this build actually contains.
*   A compiled or runtime-executed proof of the accessibility snapshot, the response-body tee, the WebSocket forwarder, or the persona apply. All of them are source implementations.

`build/args/all.gn` already sets proprietary codecs, Chrome ffmpeg branding, and Widevine flags. Those flags are unchanged here. A CDM is present only when its file exists. This checkpoint does not pretend otherwise.

## Verification gates

Pure logic is covered by `spec/agent-runtime-logic.test.ts`. It imports the production module, including response and WebSocket limit validation and per-listener delivery, and can run without an Electron binary:

```bash
node --experimental-strip-types --test spec/agent-runtime-logic.test.ts
node node_modules/typescript/bin/tsc -p tsconfig.agent-runtime-logic.json --pretty false --noEmit
```

The second command typechecks that test together with `lib/browser/api/agent-runtime-logic.ts`. It does not use `verbatimModuleSyntax`, and it is not part of `tsconfig.script.json`. Putting the test under `script/` made `tsc -p tsconfig.script.json` parse the CommonJS logic module with `verbatimModuleSyntax`. The test now lives under `spec/`.

`spec/api-agent-runtime.spec.ts` and `spec/fixtures/agent-runtime/` exercise the registered API inside Electron. The new cases cover an asynchronous response body, unsubscribe and session close, and a local WebSocket server for text, binary, empty, and fragmented messages, both directions, truncation, an in-flight skip, session isolation, unsubscribe, a webRequest listener, handshake failure, and a dropped socket. permessage-deflate is not produced by that fixture. Those specs were not executed in this checkpoint. They must not be described as passed until `e test` runs them. The C++ bindings were not compiled. A focused native test binary is also pending for the same reason.

Not run for this checkpoint, and not claimed:

*   `e sync`, `gclient`, or a Chromium checkout. The WebSocket contracts were read from the public Chromium `159.0.8140.0` sources for `websocket.mojom`, `services/network/websocket.cc`, `net/websockets/websocket_channel.cc`, `net/websockets/websocket_deflate_stream.h`, `content/browser/websockets/websocket_connector_impl.cc`, and Blink `websocket_channel_impl.cc`. That reading is not a runtime proof.
*   `e build` or any full Electron build
*   `e test` or vitest under Electron
*   `script/gen-filenames.mts`. Running it here would drop `node_header_sources`, because `../third_party/electron_node` and `../v8` are not checked out. `agent-persona.md`, `agent-persona-apply.md`, `agent-persona-screen.md`, `agent-persona-webgl.md`, and `agent-persona-webgpu.md` were inserted into `filenames.auto.gni` in sorted order by hand. No new C++ file was added.

`docs/api-history.schema.json` accepts `https://github.com/oceanDeep512/electron/pull/1` in addition to `electron/electron` pull requests. The history blocks use that fork pull request. No `electron/electron` pull request number was invented.

This checkpoint ran:

*   `node --experimental-strip-types --test spec/agent-runtime-logic.test.ts` — exit 0, 21 passed, 0 failed. Node prints `MODULE_TYPELESS_PACKAGE_JSON`. The test covers the persona decision. It does not execute C++.
*   `node node_modules/typescript/lib/tsc.js -p tsconfig.agent-runtime-logic.json --pretty false --noEmit` — exit 0.
*   `node node_modules/typescript/lib/tsc.js -p tsconfig.script.json --pretty false --noEmit` — exit 0, no diagnostics.
*   `node --experimental-strip-types --check` on the logic module, the runtime module, the logic test, and `spec/api-agent-runtime.spec.ts` — exit 0. That is syntax only.
*   `node script/create-api-json.mjs` — exit 0. `node node_modules/@electron/typescript-definitions/dist/bin.js --api=electron-api.json` — exit 0. `nativePersona` is an object, and `setAgentPersona` includes the screen, WebGL, WebGPU, seed, and WebRTC fields in the generated JSON and `electron.d.ts`. Those generated files are gitignored.
*   `node spec/ts-smoke/runner.js` — exit 0.
*   `node node_modules/typescript/lib/tsc.js -p tsconfig.electron.json --pretty false --noEmit` — exit 1, ten errors, all missing `@node/...` because `../third_party/electron_node` is not checked out. No error names an agent runtime file.
*   `node node_modules/typescript/lib/tsc.js -p tsconfig.spec.json --pretty false --noEmit` — exit 0, no diagnostics. `spec/api-agent-runtime.spec.ts` typechecks. It was not executed.
*   `node node_modules/@electron/lint-roller/dist/bin/lint-markdown-api-history.js` with the repo's history arguments — exit 0, 134 blocks, 0 errors, 1 pre-existing warning in `crash-reporter.md`.
*   `git apply --check`, then `git apply`, in `patches/chromium/.patches` order, on one sparse tree of the pinned `159.0.8140.0` files those patches touch. Each `--check` exited 0: `agent_persona_renderer_hardware_overrides.patch`, `agent_persona_worker_user_agent.patch`, `agent_persona_screen_metrics.patch`, `agent_persona_webgl_webgpu_identifiers.patch`, `agent_persona_canvas_readback.patch`, `agent_persona_audio_readback.patch`, `agent_persona_media_query_screen.patch`, `agent_persona_media_query_hdr.patch`, `agent_persona_font_core.patch`, and `agent_runtime_worker_websocket.patch`. Later patches were checked against the tree after the earlier patches had been applied. That is not a full Chromium tree and not a compile. WebRTC has no patch.

oxlint is not installed in this environment. clang-format is not installed. `e build` and `e test` were not run. The C++ persona apply, the Chromium patches, the response-body tee, the WebSocket forwarder, and the accessibility snapshot binding are source only. `spec/api-agent-runtime.spec.ts` was not executed.

## What remains before this v1 is source-complete

The control plane, navigation and input, accessibility snapshot, HTTP body observation, page WebSocket observation, and the persona surfaces below now have source. That source is not compiled. The items still missing from the written v1 are:

*   A bundled core font file and identical text metrics on every operating system. The family gate is implemented. The host still supplies the faces that remain.
*   Extension `ProxyWebSocket` for shared and service workers. The extension method requires a frame.
*   A Chromium tree with these patches applied and compiled, and an Electron binary that runs `spec/api-agent-runtime.spec.ts`. Those are the verification steps that are still absent. They are not another unwritten surface.

# agentRuntime

<!--
```YAML history
added:
  - pr-url: https://github.com/oceanDeep512/electron/pull/1
    description: "Added a main-process agentRuntime control plane and accessibility snapshots."
changes:
  - pr-url: https://github.com/oceanDeep512/electron/pull/1
    description: "Applied user agent, language, timezone, and hardware persona surfaces."
```
-->

> Main-process session and page control, plus one-shot accessibility snapshots.

Process: [Main](../glossary.md#main-process)

`agentRuntime` creates named partitions and drives pages without the debugger.
It does not change webPreferences of a page it did not create. A persona applies
user agent, client hints metadata, accept languages, timezone, hardware concurrency,
and device memory, including dedicated workers, shared workers, and service
workers. Screen, WebGL, WebGPU, canvas, audio, WebRTC policy, and font
policy `core` are not applied.

```js
const { agentRuntime } = require('electron')

const runtimeSession = agentRuntime.createSession({ partition: 'alpha' })
const page = runtimeSession.createPage({ show: false, width: 800, height: 600 })
const result = await page.goto('https://example.test/')
const tree = await page.snapshot({ framePolicy: 'same-origin' })
page.close()
runtimeSession.close()
```

## Properties

### `agentRuntime.checkpoint` _Readonly_

An `Object` frozen record of the pinned baseline and which stages are present in this build.

* `baseline` string - Fork baseline commit.
* `chromium` string - Pinned Chromium version.
* `electron` string - Nightly version that matches the baseline commit.
* `isolatedWorldId` Integer - Isolated world used for locator and content scripts. `1001`.
* `maxInFlight` Integer - Maximum concurrent operations on one page. `4`.
* `defaultNavigationTimeoutMs` Integer
* `defaultActionTimeoutMs` Integer
* `maxTimeoutMs` Integer
* `controlPlane` boolean - `true` when session and page control is present.
* `nativePersona` Object - Which persona surfaces this build applies.
  * `userAgent` boolean - `true` for the document user-agent string and HTTP `User-Agent`.
  * `clientHints` boolean - `true` for `navigator.userAgentData` and the `Sec-CH-UA*` metadata on that document override.
  * `acceptLanguages` boolean - `true` for the network `Accept-Language` header and renderer `navigator.languages`.
  * `timezone` boolean - `true` for that session's renderer processes, including their workers.
  * `hardwareConcurrency` boolean
  * `deviceMemory` boolean
  * `screen` boolean - `false`.
  * `webgl` boolean - `false`.
  * `webgpu` boolean - `false`.
  * `canvas` boolean - `false`. The seed is stored and does not change pixels.
  * `audio` boolean - `false`.
  * `webrtc` boolean - `false`. Only `default` is accepted.
  * `fonts` boolean - `false`. `fontPolicy: "core"` is rejected.
* `accessibilitySnapshot` boolean - `true` when `page.snapshot()` is wired to `WebContents::RequestAXTreeSnapshot`.
* `responseBodyObservation` boolean - `true` when `session.observeResponses()` is wired to the URL loader tee.
* `webSocketMessageObservation` boolean - `true` when `session.observeWebSockets()` is wired to the WebSocket forwarder.

### `agentRuntime.AgentRuntimeError` _Readonly_

An `Error` subclass thrown by this module. `error.code` is a string such as
`invalid-partition`, `persona-surface-unavailable`, `font-policy-unavailable`, `timeout`, `aborted`,
`navigation-failed`, or `snapshot-failed`.

## Methods

### `agentRuntime.createSession(options)`

* `options` Object
  * `partition` string - Required partition name. Must not be empty. An empty string is rejected so this method never uses the default session.
  * `persist` boolean (optional) - When omitted, a `persist:` prefix means persistent storage and a bare name means in-memory storage.
  * `persona` [AgentPersona](structures/agent-persona.md) (optional) - Applies the implemented surfaces before the partition's first page. `null` is invalid. `screen`, `webgl`, `webgpu`, and a non-default `webrtcIpHandlingPolicy` fail with `persona-surface-unavailable` and apply nothing. `fontPolicy: "core"` fails with `font-policy-unavailable`.

Returns [`AgentSession`](agent-runtime.md#class-agentsession)

Reuses the open handle when the same storage partition is requested with the same persistence and the same persona id. A different `persist` value or a different persona throws `partition-conflict`.

### `agentRuntime.resolvePartition(options)`

* `options` Object
  * `partition` string
  * `persist` boolean (optional)

Returns `Object`:

* `storagePartition` string - Value passed to `session.fromPartition`.
* `persist` boolean
* `name` string - Name with at most one `persist:` prefix removed.

Throws the same partition errors as `createSession` and does not create a session.

### `agentRuntime.validatePersona(persona)`

* `persona` any

Returns `Object` - A shape check only. A successful result does not by itself change a renderer. `createSession` performs the native apply.

* `ok` boolean
* `errors` string[] (optional) - Present when `ok` is false.
* `persona` [AgentPersona](structures/agent-persona.md) (optional) - Present when `ok` is true.

## Class: AgentSession

A handle around one Electron `Session`. `close()` drops the handle and destroys
windows this API created. It does not delete the Chromium storage partition and
does not destroy an adopted `WebContents`.

### Instance Properties

#### `session.personaApplied` _Readonly_

A `boolean`. `true` after this handle applied a persona to the partition.

#### `session.personaId` _Readonly_

A `string | null` - Canonical persona identity when a persona was applied. `null` when the session has no persona. Closing the handle does not clear the partition's persona.

#### `session.persist` _Readonly_

A `boolean`. Whether the storage partition is persistent.

#### `session.storagePartition` _Readonly_

A `string`. The partition string, including `persist:` when persistent.

#### `session.session` _Readonly_

A [`Session`](session.md) used by this handle.

#### `session.isClosed` _Readonly_

A `boolean` that is true after `close()`.

### Instance Methods

#### `session.createPage([options])`

* `options` Object (optional)
  * `webContents` [WebContents](web-contents.md) (optional) - Adopt this page. webPreferences, preload, visibility, and size are left unchanged. The page must already use this session.
  * `show` boolean (optional) - Default is `false`. Rejected when `webContents` is set.
  * `width` Integer (optional) - Default is `800`. Rejected when `webContents` is set.
  * `height` Integer (optional) - Default is `600`. Rejected when `webContents` is set.

Returns [`AgentPage`](agent-runtime.md#class-agentpage)

A page this API creates uses `sandbox: true`, `contextIsolation: true`, `webSecurity: true`, and turns node integration off, including workers and subframes. No preload is added. `show`, `width`, and `height` apply only to that new window.

#### `session.observeResponses(options, listener)`

<!--
```YAML history
added:
  - pr-url: https://github.com/oceanDeep512/electron/pull/1
    description: "Added bounded HTTP response body observation."
```
-->

* `options` Object
  * `urls` string[] (optional) - Full-URL prefixes, or a prefix and suffix around one `*`. An empty list observes every `http` and `https` URL. At most 32 patterns, each 1 to 2048 characters and at most one `*`.
  * `maxBytesPerResponse` Integer (optional) - Captured prefix per response. Default is `1000000`. Must be from 1 to 10000000.
  * `maxInFlight` Integer (optional) - Responses captured at once. Default is `8`. Must be from 1 to 64. Further responses are skipped.
  * `maxAggregateBytes` Integer (optional) - Bytes held for in-flight captures. Default is `8000000`. Must be from 1 to 64000000.
* `listener` Function
  * `event` [ResponseBodyObservation](structures/response-body-observation.md)

Returns `Function` - Call the returned function to remove this listener. The last listener turns observation off for the session.

Observation is opt-in and session scoped. With no listeners, renderer requests stay on the direct network path. The listener receives response bytes, so a body, a URL, or a redirect target may contain secrets. This method does not redact that data and does not write it to disk or to a log.

`body` is a copy of the bytes on the network data pipe. For an ordinary page or `fetch` request those are the bytes `URLRequest::Read` produced after Chromium's content-encoding filter. `networkDecoded` is false when the request asked for client-side content decoding; the bytes are still copied unchanged. A `redirect` event has `body: null` and does not stand in for the final response. A `skipped` event means this response was not captured. The page's request still completes.

Hitting a capture limit does not fail or stall the request. `truncated: true` means only a prefix was delivered to the listener. `skipReason` tells why a response was not captured. `queueDropped` counts observation events discarded because the UI queue was full.

This is not a capture of every network response. It does not see requests that leave `WillCreateURLLoaderFactory` through the extensions early return, CORS preflights, `file:` URLs, custom protocols, or WebSocket.

#### `session.observeWebSockets(options, listener)`

<!--
```YAML history
added:
  - pr-url: https://github.com/oceanDeep512/electron/pull/1
    description: "Added bounded WebSocket message observation."
```
-->

* `options` Object
  * `urls` string[] (optional) - Full-URL prefixes, or a prefix and suffix around one `*`. An empty list observes every `ws` and `wss` URL. At most 32 patterns, each 1 to 2048 characters and at most one `*`.
  * `maxBytesPerMessage` Integer (optional) - Captured prefix per message. Default is `1000000`. Must be from 1 to 10000000.
  * `maxInFlight` Integer (optional) - Connections captured at once. Default is `8`. Must be from 1 to 64. Further connections are skipped.
  * `maxAggregateBytes` Integer (optional) - Bytes held for in-flight captures. Default is `8000000`. Must be from 1 to 64000000.
* `listener` Function
  * `event` [WebSocketMessageObservation](structures/websocket-message-observation.md)

Returns `Function` - Call the returned function to remove this listener. The last listener turns observation off for the session.

Observation is opt-in and session scoped. With no listeners, page and dedicated-worker sockets are not proxied for messages. The listener receives message bytes, which may contain secrets. This method does not redact them and does not write them to disk or to a log.

`body` is the logical message. Incoming frames are the bytes `net::WebSocketChannel` delivered after `WebSocketDeflateStream` inflation. Outgoing bytes are what the renderer wrote before the network service deflates them. `wireCompressed` is true when the handshake extensions include `permessage-deflate`. `text` is set only for a complete, valid UTF-8 text message. A truncated or invalid text message keeps `text` null and still carries the captured bytes. Ping and pong are not events. A redirect-style event is not synthesized.

Shared workers, service workers, and `net.WebSocket` are outside this path. Extension websocket proxies are also outside it. Handshake failure emits `failed` and no body. A capture limit skips or truncates the copy and does not drop the socket's real frames.

#### `session.close()`

Closes every page handle, removes response and WebSocket listeners, and stops new captures. Owned windows are destroyed. Adopted `WebContents` are not destroyed. The in-memory session record is dropped. A capture already in flight keeps forwarding bytes to the page or socket and does not deliver them after the listener is gone.

## Class: AgentPage

### Instance Properties

#### `page.adopted` _Readonly_

A `boolean` that is true when the page was an existing `WebContents`.

#### `page.webContents` _Readonly_

A [`WebContents`](web-contents.md) for this page.

### Instance Methods

#### `page.goto(url[, options])`

* `url` string - `http:`, `https:`, `file:`, or `data:` only.
* `options` Object (optional)
  * `timeoutMs` Integer (optional) - Default is `30000`.
  * `signal` AbortSignal (optional)

Returns `Promise<Object>`:

* `url` string - `webContents.getURL()` after the main frame finishes loading.
* `httpStatus` Integer | null - From `did-navigate` or a main-frame `did-frame-navigate` when the code is from 100 to 599. Otherwise null. This method never substitutes 200.
* `httpStatusText` string
* `httpStatusSource` string - `did-navigate` or `unavailable`.

The initial `about:blank` document, same-document navigations, and subframe navigations are ignored. A server redirect is the later commit and keeps the final HTTP status. A second cross-document main-frame start before finish fails the attempt. `loadURL` resolving is not success. A `loadURL` rejection other than `ERR_ABORTED` (-3) fails immediately. `ERR_INVALID_URL` and other non-abort failures reported before the navigation starts also fail immediately. `ERR_ABORTED` before the start is ignored because Chromium can attach it to the initial `about:blank` load. Status still comes only from the commit event.

#### `page.snapshot([options])`

<!--
```YAML history
added:
  - pr-url: https://github.com/oceanDeep512/electron/pull/1
    description: "Added page.snapshot() from the Chromium accessibility tree."
```
-->

* `options` Object (optional)
  * `maxNodes` Integer (optional) - Default is `2000`. Maximum is `100000`.
  * `timeoutMs` Integer (optional) - Default is `10000`.
  * `signal` AbortSignal (optional)
  * `framePolicy` string (optional) - `all` or `same-origin`. Default is `all`.

Returns `Promise<Object>` - Roles, names, child and parent links, and bounds from [`webContents.captureAccessibilitySnapshot`](web-contents.md#contentscaptureaccessibilitysnapshotoptions). This is not built from the DOM and does not use the debugger.

* `rootId` Integer | null
* `focusId` Integer | null
* `url` string
* `title` string
* `framePolicy` string - `all` or `same-origin`.
* `maxNodes` Integer
* `nodeCount` Integer
* `mayBeTruncated` boolean - `true` when `nodeCount` reached `maxNodes`. A Chromium timeout can also return a shorter tree without setting this flag.
* `stitching` string - `chromium-ax-tree-combiner`.
* `inlineTextBoxes` string - `stripped-by-chromium`.
* `crossFrameBounds` string - `relative-chain-without-transforms`.
* `crossOriginStitch` string - `linked-when-parent-tree-id-matches`. A child frame is present only when Chromium included that frame and the child tree names this tree as its parent. `same-origin` prunes cross-origin, cross-site, and fenced frames, including a descendant that later returns to the same origin.
* `nodes` [AgentAccessibilityNode[]](structures/agent-accessibility-node.md)

A timeout, abort, destroyed page, crashed renderer, or cross-document main-frame navigation rejects the promise. A late tree from Chromium is not returned after that rejection. The page script used by locators cannot be cancelled, but a late script result does not send input after the operation has settled.

#### `page.content([options])`

* `options` Object (optional)
  * `maxChars` Integer (optional) - Default is `200000`. Maximum is `1000000`.
  * `timeoutMs` Integer (optional)
  * `signal` AbortSignal (optional)

Returns `Promise<Object>`:

* `html` string
* `truncated` boolean
* `length` Integer

The HTML is read in isolated world `1001` and truncated again in the main process.

#### `page.locator(selector)`

* `selector` string - CSS selector. It is passed with `JSON.stringify` and is not interpolated into script source.

Returns [`AgentLocator`](agent-runtime.md#class-agentlocator)

The locator searches the main frame only. An element inside an iframe is not found.

#### `page.close()`

Drops the handle and removes its listeners. An owned window is destroyed. An adopted `WebContents` is not destroyed.

## Class: AgentLocator

### Instance Methods

#### `locator.boundingBox([options])`

* `options` Object (optional)
  * `timeoutMs` Integer (optional)
  * `signal` AbortSignal (optional)
  * `scroll` boolean (optional) - Default is `true`.

Returns `Promise<Object>` - CSS pixels from the main frame. Overlay hit-testing is not performed.

* `x` number
* `y` number
* `width` number
* `height` number
* `visible` boolean
* `disabled` boolean
* `editable` boolean

#### `locator.click([options])`

* `options` Object (optional)
  * `timeoutMs` Integer (optional)
  * `signal` AbortSignal (optional)
  * `button` string (optional) - `left`, `middle`, or `right`. Default is `left`.
  * `scroll` boolean (optional)

Returns `Promise<void>`

The click point is the CSS box center multiplied by `webContents.zoomFactor`, then rounded. `deviceScaleFactor` is not applied. Iframe offsets are not applied. The call focuses the window and the web contents, then sends mouse move, mouse down, and mouse up. Operating-system focus is not guaranteed. If the operation times out or aborts while the page script is still running, the input events are not sent.

#### `locator.fill(text[, options])`

* `text` string - At most 100000 characters and no NUL. Sent with `insertText`, not with script concatenation.
* `options` Object (optional)
  * `timeoutMs` Integer (optional)
  * `signal` AbortSignal (optional)

Returns `Promise<void>`

#### `locator.press(key[, options])`

* `key` string - One character, keeping its case, or a named key such as `Enter`, `Tab`, `Escape`, an arrow, or `Space`. Modifier chords are rejected.
* `options` Object (optional)
  * `timeoutMs` Integer (optional)
  * `signal` AbortSignal (optional)

Returns `Promise<void>`

`Enter` and `Tab` send key down and key up only. `Space` also sends a char event.

#### `locator.inputValue([options])`

* `options` Object (optional)
  * `timeoutMs` Integer (optional)
  * `signal` AbortSignal (optional)

Returns `Promise<string>`

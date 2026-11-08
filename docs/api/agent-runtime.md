# agentRuntime

<!--
```YAML history
added:
  - pr-url: https://github.com/oceanDeep512/electron/pull/1
    description: "Added a main-process agentRuntime control plane and accessibility snapshots."
```
-->

> Main-process session and page control, plus one-shot accessibility snapshots.

Process: [Main](../glossary.md#main-process)

`agentRuntime` creates named partitions and drives pages without the debugger.
It does not change webPreferences of a page it did not create. Native fingerprint
personas, HTTP response bodies, and WebSocket message bodies are not implemented.
Passing a persona throws `native-persona-unavailable` and does not call
`session.fromPartition`.

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
* `nativePersona` boolean - `false`. A persona is not applied.
* `accessibilitySnapshot` boolean - `true` when `page.snapshot()` is wired to `WebContents::RequestAXTreeSnapshot`.
* `responseBodyObservation` boolean - `true` when `session.observeResponses()` is wired to the URL loader tee.
* `webSocketMessageObservation` boolean - `false`.

### `agentRuntime.AgentRuntimeError` _Readonly_

An `Error` subclass thrown by this module. `error.code` is a string such as
`invalid-partition`, `native-persona-unavailable`, `timeout`, `aborted`,
`navigation-failed`, or `snapshot-failed`.

## Methods

### `agentRuntime.createSession(options)`

* `options` Object
  * `partition` string - Required partition name. Must not be empty. An empty string is rejected so this method never uses the default session.
  * `persist` boolean (optional) - When omitted, a `persist:` prefix means persistent storage and a bare name means in-memory storage.
  * `persona` any (optional) - Must be omitted. An object fails with `native-persona-unavailable` before the partition is reserved. `null` is invalid.

Returns [`AgentSession`](agent-runtime.md#class-agentsession)

Reuses the open handle when the same storage partition is requested with the same persistence and a null persona id. A different `persist` value throws `partition-conflict`.

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

Returns `Object` - A shape check only. A successful result does not change a renderer, the network stack, Client Hints, timezone, WebGL, canvas, audio, fonts, or WebRTC.

* `ok` boolean
* `errors` string[] (optional) - Present when `ok` is false.
* `persona` Object (optional) - Present when `ok` is true.

## Class: AgentSession

A handle around one Electron `Session`. `close()` drops the handle and destroys
windows this API created. It does not delete the Chromium storage partition and
does not destroy an adopted `WebContents`.

### Instance Properties

#### `session.personaApplied` _Readonly_

A `boolean`. Always `false` in this build. No persona is stored or applied.

#### `session.personaId` _Readonly_

A `null`. Always null in this build.

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

Hitting a capture limit does not fail or stall the request. `truncated: true` means only a prefix was delivered to the listener. `skipReason` tells why a response was not captured.

#### `session.close()`

Closes every page handle, removes response listeners, and stops new captures. Owned windows are destroyed. Adopted `WebContents` are not destroyed. The in-memory session record is dropped. A capture already in flight keeps forwarding bytes to the page and does not deliver them after the listener is gone.

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

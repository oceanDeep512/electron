# Agent Runtime

This page records the second checkpoint of the agent runtime. The main-process control plane is repaired, and `page.snapshot()` reads Chromium's accessibility tree. Native fingerprint persona, HTTP response bodies, and WebSocket message bodies are still not implemented.

## Status of this checkpoint

| Area | Status |
| --- | --- |
| Design record and baseline pin | Written on this page |
| `agentRuntime` session and page control plane | Implemented in the main process |
| Public docs and generated TypeScript surface | `docs/api/agent-runtime.md` and `webContents.captureAccessibilitySnapshot` |
| Navigation, locator, and input without CDP | Implemented, with the boundaries below |
| Persona config validation | Implemented as a pure check |
| Applying a fingerprint persona | Not implemented. `createSession` rejects a persona |
| Accessibility snapshot | Wired to `WebContents::RequestAXTreeSnapshot` |
| HTTP response body observation | Not implemented |
| WebSocket message body observation | Not implemented |

`electron.agentRuntime.checkpoint` exposes the same flags at runtime. `accessibilitySnapshot` is true. `nativePersona`, `responseBodyObservation`, and `webSocketMessageObservation` are false.

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

`validatePersona` only checks the shape of a future persona. A successful result means the object is well formed. It does not change a renderer, the network stack, Client Hints, timezone, WebGL, canvas, audio, fonts, or WebRTC. `createSession` with a persona object fails with `native-persona-unavailable` before `session.fromPartition`, so a rejected persona does not reserve the partition. `persona: null` is invalid. Omit the property to create a normal session.

The future native stage must apply a persona before the first renderer for that partition starts, including service workers, and must keep it immutable for the life of the partition. `personaStorageId` is the canonical JSON of a validated persona. `createSession` does not call it and does not keep a persona map. Two open handles may share a partition only when persistence matches and both persona ids are null.

`fontPolicy: "core"` can pass validation. It is still not applied. The native stage must reject that policy if it cannot be implemented honestly.

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

## Explicitly not implemented

The following stay out of this checkpoint. They are the next stages, not hidden behavior of the current API.

*   Native persona application, including user agent and Client Hints, locale, timezone, hardware concurrency, device memory, screen, WebGL, WebGPU identity, canvas, audio, fonts, and WebRTC IP policy.
*   Passive HTTP response body capture. The body must be tee'd from the URL loader data pipe on both the direct path and the proxy path, without adding observer backpressure or dropping the pipe before completion.
*   WebSocket message body capture. Frame metadata and payload bytes are separate, and the current proxy drops the connection endpoints after connect.
*   Any claim that a persona is undetectable, or that codecs and Widevine are something other than what this build actually contains.

`build/args/all.gn` already sets proprietary codecs, Chrome ffmpeg branding, and Widevine flags. Those flags are unchanged here. A CDM is present only when its file exists. This checkpoint does not pretend otherwise.

## Verification gates

Pure logic is covered by `script/agent-runtime-logic.test.mts`. It imports the production module and can run without an Electron binary:

```bash
node --experimental-strip-types --test script/agent-runtime-logic.test.mts
```

`spec/api-agent-runtime.spec.ts` and `spec/fixtures/agent-runtime/` exercise the registered API inside Electron: partition isolation, adoption, HTTP 201 and 404, non-HTTP status, cancellation, input, and accessibility snapshots with a same-origin iframe and a cross-origin iframe. Those specs were not executed in this checkpoint. They must not be described as passed until `e test` runs them. The C++ binding was not compiled.

Not run for this checkpoint, and not claimed:

*   `e sync`, `gclient`, or a Chromium checkout beyond the pinned public headers that were read for `RequestAXTreeSnapshot`
*   `e build` or any full Electron build
*   `e test` or vitest under Electron

`filenames.auto.gni` is still produced by `script/gen-filenames.mts`. Running that generator here would drop `node_header_sources`, because `../third_party/electron_node` and `../v8` are not checked out. The browser bundle graph and the `lib/` typecheck list were compared with the generator's own rules instead. `docs/api/agent-runtime.md` is listed with the other API docs.

`docs/api-history.schema.json` accepts `https://github.com/oceanDeep512/electron/pull/1` in addition to `electron/electron` pull requests. The history blocks use that fork pull request. No `electron/electron` pull request number was invented. `lint-roller-markdown-api-history` reads that schema and reported 0 errors. A warning in `crash-reporter.md` is pre-existing.

This checkpoint ran:

*   `node --experimental-strip-types --test script/agent-runtime-logic.test.mts` — 18 passed, 0 failed. This executes the production logic module. It is not an Electron runtime test.
*   `node --experimental-strip-types --check` on the logic module, the runtime module, the logic test, and the spec. That is syntax only, not a typecheck.
*   `node script/create-api-json.mjs` and `electron-typescript-definitions --api=electron-api.json`. `agentRuntime` and `captureAccessibilitySnapshot` are in the generated JSON and `electron.d.ts`. Those generated files are gitignored.
*   `node spec/ts-smoke/runner.js` — exit 0. That typechecks `electron.d.ts`.
*   `tsc -p tsconfig.electron.json` reports no errors in the agent runtime files. The same command exits 1 because `@node/...` imports need `../third_party/electron_node`, which is not checked out.
*   `tsc -p tsconfig.spec.json` reports no errors in `spec/api-agent-runtime.spec.ts` when `vitest` is stubbed. The real `vitest` package was not installed: `npm install vitest@5` crashed in npm's arborist (`edgesOut`).
*   `node ./build/bundle/bundle.mjs --target <target> --print-graph` for every bundle target matches `filenames.auto.gni`. `lib_typecheck_sources` matches the generator's `lib/` walk. `script/gen-filenames.mts` itself was not run, because it would also rewrite `node_header_sources` from the missing Node and V8 trees.

oxlint is not installed in this environment. `e build` and `e test` were not run. The C++ snapshot binding is therefore uncompiled, and the Electron specs are unexecuted.

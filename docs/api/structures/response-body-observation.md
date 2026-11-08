# ResponseBodyObservation Object

* `requestId` string - Stable id for one HTTP request, shared by its redirect, opened, completed, aborted, and skipped events.
* `phase` string - `opened`, `redirect`, `completed`, `aborted`, or `skipped`.
* `url` string - Request URL for `opened`, the URL being left for `redirect`, and the response URL after redirects for `completed` and `aborted`.
* `redirectUrl` string - Destination of a redirect. Empty for every other phase.
* `status` Integer - HTTP status. `0` when the response had no status line.
* `mimeType` string - MIME type from the response head. Empty when the head did not carry one.
* `networkDecoded` boolean - True when the data pipe was filled by `URLRequest::Read` without client-side content decoding. Meaningful on `completed` and `aborted`.
* `truncated` boolean - True when the captured prefix stopped at a byte cap. The page still receives the rest of the body.
* `skipReason` string - Empty, or `in-flight-limit`, `aggregate-limit`, or `tee-failed`.
* `errorCode` Integer - Network error code. `0` for `net::OK`.
* `body` Buffer | null - Exact captured bytes. Null for `opened`, `redirect`, and `skipped`. An empty buffer is a real empty body, not a missing one.

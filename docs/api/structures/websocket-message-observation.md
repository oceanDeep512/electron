# WebSocketMessageObservation Object

* `connectionId` string - Stable id for one WebSocket connection.
* `messageId` string - Id for one assembled message. Empty for `opened`, `closed`, `failed`, and `skipped`.
* `phase` string - `opened`, `message`, `closed`, `failed`, or `skipped`.
* `url` string - The `ws` or `wss` request URL.
* `direction` string - `received`, `sent`, or empty when the event is not a message.
* `opcode` string - `text`, `binary`, `continuation`, or empty. An assembled message uses the opcode of its first frame.
* `body` Buffer | null - Exact captured bytes. Null when the event is not a message. An empty buffer is a real empty message.
* `text` string | null - The message text when `opcode` is `text`, the message is complete, and the bytes are valid UTF-8. Otherwise null.
* `truncated` boolean - True when the captured prefix stopped at a byte cap or the connection closed mid-message. The socket still receives the rest of the message.
* `skipReason` string - Empty, or `in-flight-limit`, `aggregate-limit`, `tee-failed`, or `dispatch-queue`.
* `wireCompressed` boolean - True when the handshake extensions include `permessage-deflate`. The bytes are still the logical message.
* `wasClean` boolean - From `OnDropChannel`. Meaningful on `closed`.
* `code` Integer - Close code. `0` when the event has no close code.
* `reason` string - Close reason. Empty when there is none.
* `errorCode` Integer - Network error code. `0` for `net::OK`.
* `queueDropped` Integer - How many earlier observation events were discarded because the UI queue was full. `0` when none were discarded.

// Copyright (c) 2026 GitHub, Inc.
// Use of this source code is governed by the MIT license that can be
// found in the LICENSE file.

#ifndef ELECTRON_SHELL_BROWSER_NET_WEBSOCKET_MESSAGE_OBSERVER_H_
#define ELECTRON_SHELL_BROWSER_NET_WEBSOCKET_MESSAGE_OBSERVER_H_

#include <deque>
#include <memory>
#include <string>
#include <vector>

#include "base/synchronization/lock.h"
#include "mojo/public/cpp/bindings/pending_receiver.h"
#include "mojo/public/cpp/bindings/pending_remote.h"
#include "mojo/public/cpp/system/data_pipe.h"
#include "services/network/public/mojom/websocket.mojom.h"
#include "shell/browser/net/url_loader_factory_gate.h"
#include "v8/include/v8-forward.h"

class GURL;

namespace electron {

// Kept in sync with lib/browser/api/agent-runtime-logic.ts.
inline constexpr size_t kWebSocketDefaultMaxBytes = 1000000;
inline constexpr size_t kWebSocketMaxBytes = 10000000;
inline constexpr int kWebSocketDefaultMaxInFlight = 8;
inline constexpr int kWebSocketMaxInFlight = 64;
inline constexpr size_t kWebSocketDefaultAggregateBytes = 8000000;
inline constexpr size_t kWebSocketMaxAggregateBytes = 64000000;
inline constexpr size_t kWebSocketMaxQueuedEvents = 64;

struct WebSocketLimits {
  std::vector<std::string> patterns;
  size_t max_bytes_per_message = kWebSocketDefaultMaxBytes;
  int max_in_flight = kWebSocketDefaultMaxInFlight;
  size_t max_aggregate_bytes = kWebSocketDefaultAggregateBytes;
};

// One observation event. Message bytes are the logical payload: incoming
// frames are already inflated by net::WebSocketDeflateStream, and outgoing
// bytes are what the renderer wrote before the network service deflates them.
struct WebSocketEvent {
  std::string phase;
  std::string connection_id;
  std::string message_id;
  uint64_t generation = 0;
  std::string url;
  std::string direction;
  std::string opcode;
  bool has_body = false;
  bool truncated = false;
  bool has_text = false;
  std::string text;
  std::string skip_reason;
  bool wire_compressed = false;
  bool was_clean = false;
  int code = 0;
  std::string reason;
  int error_code = 0;
  int queue_dropped = 0;
  size_t buffered = 0;
  std::vector<uint8_t> body;
};

enum class WebSocketClaimKind { kIgnore, kSkip, kClaim };

struct WebSocketTicket {
  WebSocketClaimKind kind = WebSocketClaimKind::kIgnore;
  std::string connection_id;
  uint64_t generation = 0;
  size_t max_bytes = 0;
  std::string url;
  std::string skip_reason;
};

class WebSocketListener;

// Counters and the UI queue for one session. Owned by InterceptState.
class WebSocketObservation {
 public:
  WebSocketObservation();
  ~WebSocketObservation();

  WebSocketObservation(const WebSocketObservation&) = delete;
  WebSocketObservation& operator=(const WebSocketObservation&) = delete;

  void Install(std::unique_ptr<WebSocketListener> listener,
               WebSocketLimits limits,
               InterceptState* state);
  void UpdateLimits(WebSocketLimits limits);
  void Clear(InterceptState* state);
  WebSocketTicket Claim(const GURL& url, InterceptState* state);
  void Finish();
  size_t Accept(size_t want, size_t room);
  void Release(size_t bytes);
  bool Current(uint64_t generation) const;
  void Emit(WebSocketEvent event, InterceptState* state);
  void Drain(InterceptState* state);

 private:
  mutable base::Lock lock_;
  bool enabled_ GUARDED_BY(lock_) = false;
  uint64_t generation_ GUARDED_BY(lock_) = 1;
  WebSocketLimits limits_ GUARDED_BY(lock_);
  int in_flight_ GUARDED_BY(lock_) = 0;
  size_t aggregate_ GUARDED_BY(lock_) = 0;
  uint64_t next_id_ GUARDED_BY(lock_) = 0;
  std::deque<WebSocketEvent> queue_ GUARDED_BY(lock_);
  int queue_dropped_ GUARDED_BY(lock_) = 0;
  bool queue_scheduled_ GUARDED_BY(lock_) = false;
  std::unique_ptr<WebSocketListener> listener_;
};

[[nodiscard]] bool IsValidWebSocketPattern(const std::string& pattern);

[[nodiscard]] std::unique_ptr<WebSocketListener> MakeWebSocketListener(
    v8::Isolate* isolate,
    v8::Local<v8::Function> listener);

void ConfigureWebSocketObservation(InterceptState* state,
                                   v8::Isolate* isolate,
                                   v8::Local<v8::Function> listener,
                                   WebSocketLimits limits);

void UpdateWebSocketObservationLimits(InterceptState* state,
                                      WebSocketLimits limits);

// Hands the renderer the endpoints it should use. When the connection is
// claimed, those endpoints are a forwarder and the network endpoints stay
// inside it. Otherwise the network endpoints are returned unchanged.
struct WebSocketRendererEnds {
  mojo::PendingRemote<network::mojom::WebSocket> socket;
  mojo::PendingReceiver<network::mojom::WebSocketClient> client_receiver;
  mojo::ScopedDataPipeConsumerHandle readable;
  mojo::ScopedDataPipeProducerHandle writable;
};

WebSocketRendererEnds ObserveWebSocketConnection(
    InterceptState* state,
    const GURL& url,
    const std::string& extensions,
    mojo::PendingRemote<network::mojom::WebSocket> socket,
    mojo::PendingReceiver<network::mojom::WebSocketClient> client_receiver,
    mojo::ScopedDataPipeConsumerHandle readable,
    mojo::ScopedDataPipeProducerHandle writable);

void NotifyWebSocketHandshakeFailed(InterceptState* state,
                                    const GURL& url,
                                    int error_code);

}  // namespace electron

#endif  // ELECTRON_SHELL_BROWSER_NET_WEBSOCKET_MESSAGE_OBSERVER_H_

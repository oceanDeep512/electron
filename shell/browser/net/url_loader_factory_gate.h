// Copyright (c) 2026 Anthropic, PBC.
// Use of this source code is governed by the MIT license that can be
// found in the LICENSE file.

#ifndef ELECTRON_SHELL_BROWSER_NET_URL_LOADER_FACTORY_GATE_H_
#define ELECTRON_SHELL_BROWSER_NET_URL_LOADER_FACTORY_GATE_H_

#include <stdint.h>

#include <atomic>
#include <cstddef>
#include <memory>
#include <string>
#include <vector>

#include "base/containers/flat_set.h"
#include "base/memory/ref_counted.h"
#include "base/memory/weak_ptr.h"
#include "base/synchronization/lock.h"
#include "mojo/public/cpp/bindings/pending_receiver.h"
#include "mojo/public/cpp/bindings/pending_remote.h"
#include "services/network/public/mojom/url_loader.mojom-forward.h"
#include "services/network/public/mojom/url_loader_factory.mojom-forward.h"

class GURL;

namespace extensions {
enum class WebRequestResourceType : uint8_t;
}

namespace network {
struct ResourceRequest;
}

namespace net {
struct MutableNetworkTrafficAnnotationTag;
}

namespace electron {

class ElectronBrowserContext;

// The webRequest resource type of a renderer request, as WebRequestInfo would
// compute it. Unlike the URL it cannot change across redirects.
extensions::WebRequestResourceType ResourceTypeOf(
    const network::ResourceRequest& request);

constexpr uint32_t kAllResourceTypes = ~0u;

// Kept in sync with lib/browser/api/agent-runtime-logic.ts.
inline constexpr size_t kResponseBodyDefaultMaxBytes = 1000000;
inline constexpr size_t kResponseBodyMaxBytes = 10000000;
inline constexpr int kResponseBodyDefaultMaxInFlight = 8;
inline constexpr int kResponseBodyMaxInFlight = 64;
inline constexpr size_t kResponseBodyDefaultAggregateBytes = 8000000;
inline constexpr size_t kResponseBodyMaxAggregateBytes = 64000000;

// Limits for one session's response-body observation. Patterns are matched
// against the full URL. An empty pattern list matches every http(s) URL.
struct ResponseBodyLimits {
  std::vector<std::string> patterns;
  size_t max_bytes_per_response = kResponseBodyDefaultMaxBytes;
  int max_in_flight = kResponseBodyDefaultMaxInFlight;
  size_t max_aggregate_bytes = kResponseBodyDefaultAggregateBytes;
};

// One observation event. `has_body` is false for opened, redirect, and skipped
// events; those must not carry invented response bytes.
struct ResponseBodyEvent {
  std::string phase;
  std::string request_id;
  uint64_t generation = 0;
  std::string url;
  std::string redirect_url;
  int status = 0;
  std::string mime_type;
  bool network_decoded = true;
  bool truncated = false;
  std::string skip_reason;
  int error_code = 0;
  bool has_body = false;
  size_t buffered = 0;
  std::vector<uint8_t> body;
};

enum class ResponseBodyClaimKind { kIgnore, kSkip, kClaim };

struct ResponseBodyTicket {
  ResponseBodyClaimKind kind = ResponseBodyClaimKind::kIgnore;
  std::string request_id;
  uint64_t generation = 0;
  size_t max_bytes = 0;
  std::string url;
  std::string skip_reason;
};

class ResponseBodyListener;

// What makes a session's requests leave the direct renderer -> network path:
// a webRequest listener that can block or modify them (routed through
// ProxyingURLLoaderFactory on the UI thread), one that only observes them
// (reported to the UI thread after the fact), an intercepted scheme, or an
// --ignore-connections-limit domain. Written on the UI thread, read on IO.
class InterceptState : public base::RefCountedThreadSafe<InterceptState> {
 public:
  enum class Route { kDirect, kObserve, kProxy };

  InterceptState();

  // Bit N set = some listener of that kind matches WebRequestResourceType N.
  void SetListenerTypes(uint32_t blocking_types, uint32_t observer_types);
  void SetInterceptedSchemes(base::flat_set<std::string> schemes);
  void SetIgnoreConnectionsLimitDomains(std::vector<std::string> domains);

  Route RouteFor(const network::ResourceRequest& request) const;

  // Fast path for the URL loader gate. False means no response-body subscriber.
  bool response_body_enabled() const {
    return response_body_enabled_.load(std::memory_order_acquire);
  }

  // UI thread. Replacing the listener does not bump the generation, so a tee
  // that already started can still deliver. Clearing does.
  void InstallResponseBodyListener(std::unique_ptr<ResponseBodyListener> listener,
                                   ResponseBodyLimits limits);
  void ClearResponseBodyObservation();

  // Any thread. kIgnore emits nothing. kSkip emits a skipped event and does
  // not reserve a slot. kClaim reserves one in-flight slot.
  ResponseBodyTicket ClaimResponseBody(const GURL& url);
  void FinishResponseBodyClaim();
  size_t AcceptResponseBodyBytes(size_t want, size_t local_room);
  void ReleaseResponseBodyBytes(size_t bytes);
  bool ResponseBodyGenerationCurrent(uint64_t generation) const;
  void EmitResponseBody(ResponseBodyEvent event);

 private:
  friend class base::RefCountedThreadSafe<InterceptState>;
  ~InterceptState();

  void DeliverResponseBody(ResponseBodyEvent event);

  bool WantsURL(const GURL& url) const EXCLUSIVE_LOCKS_REQUIRED(lock_);

  mutable base::Lock lock_;
  uint32_t blocking_types_ GUARDED_BY(lock_) = 0;
  uint32_t observer_types_ GUARDED_BY(lock_) = 0;
  base::flat_set<std::string> intercepted_schemes_ GUARDED_BY(lock_);
  std::vector<std::string> ignore_connections_limit_domains_ GUARDED_BY(lock_);

  // Mirror of response_enabled_ for the no-subscriber path. The locked flag
  // is the one ClaimResponseBody trusts.
  std::atomic<bool> response_body_enabled_{false};
  bool response_enabled_ GUARDED_BY(lock_) = false;
  uint64_t response_generation_ GUARDED_BY(lock_) = 1;
  ResponseBodyLimits response_limits_ GUARDED_BY(lock_);
  int response_in_flight_ GUARDED_BY(lock_) = 0;
  size_t response_aggregate_ GUARDED_BY(lock_) = 0;
  uint64_t response_next_id_ GUARDED_BY(lock_) = 0;
  // Touched only on the UI thread. Cleared before the last ref can drop on IO.
  std::unique_ptr<ResponseBodyListener> response_body_listener_;
};

// Starts a request on the IO thread with both URLLoader endpoints proxied so
// observer only webRequest events can be reported without blocking the load.
void CreateObservedLoaderAndStartOnIO(
    base::WeakPtr<ElectronBrowserContext> browser_context,
    scoped_refptr<InterceptState> state,
    int render_process_id,
    int frame_routing_id,
    mojo::PendingReceiver<network::mojom::URLLoader> loader,
    int32_t request_id,
    uint32_t options,
    const network::ResourceRequest& request,
    mojo::PendingRemote<network::mojom::URLLoaderClient> client,
    const net::MutableNetworkTrafficAnnotationTag& traffic_annotation,
    mojo::PendingRemote<network::mojom::URLLoaderFactory> target);

// Bound on the IO thread between a renderer's factory pipe and the network:
// requests go straight to `target` unless `state` wants them on the UI thread,
// in which case `interceptor` (a ProxyingURLLoaderFactory) gets them. Lives as
// long as its receivers and both remotes do.
void CreateURLLoaderFactoryGate(
    ElectronBrowserContext* browser_context,
    int render_process_id,
    int frame_routing_id,
    mojo::PendingReceiver<network::mojom::URLLoaderFactory> receiver,
    mojo::PendingRemote<network::mojom::URLLoaderFactory> target,
    mojo::PendingRemote<network::mojom::URLLoaderFactory> interceptor);

}  // namespace electron

#endif  // ELECTRON_SHELL_BROWSER_NET_URL_LOADER_FACTORY_GATE_H_

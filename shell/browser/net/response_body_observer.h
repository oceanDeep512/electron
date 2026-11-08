// Copyright (c) 2026 GitHub, Inc.
// Use of this source code is governed by the MIT license that can be
// found in the LICENSE file.

#ifndef ELECTRON_SHELL_BROWSER_NET_RESPONSE_BODY_OBSERVER_H_
#define ELECTRON_SHELL_BROWSER_NET_RESPONSE_BODY_OBSERVER_H_

#include <memory>
#include <string>

#include "mojo/public/cpp/bindings/pending_receiver.h"
#include "mojo/public/cpp/bindings/pending_remote.h"
#include "mojo/public/cpp/system/data_pipe.h"
#include "services/network/public/mojom/url_loader.mojom-forward.h"
#include "services/network/public/mojom/url_loader_factory.mojom-forward.h"
#include "services/network/public/mojom/url_response_head.mojom-forward.h"
#include "shell/browser/net/url_loader_factory_gate.h"
#include "v8/include/v8-forward.h"

class GURL;

namespace net {
struct MutableNetworkTrafficAnnotationTag;
struct RedirectInfo;
}  // namespace net

namespace network {
struct ResourceRequest;
}  // namespace network

namespace electron {

class InterceptState;

// Builds the UI-thread listener. The returned object is only destroyed on the
// UI thread.
class ResponseBodyListener;

[[nodiscard]] bool IsValidResponseBodyPattern(const std::string& pattern);

[[nodiscard]] std::unique_ptr<ResponseBodyListener> MakeResponseBodyListener(
    v8::Isolate* isolate,
    v8::Local<v8::Function> listener);

// Installs the listener on the UI thread. The listener object is destroyed on
// that thread; callers do not see its destructor.
void ConfigureResponseBodyObservation(InterceptState* state,
                                      v8::Isolate* isolate,
                                      v8::Local<v8::Function> listener,
                                      ResponseBodyLimits limits);

// Follows one claimed request. MaybeCreate returns null when the request is
// not observed. A skip already emitted its event and still returns null so
// the caller keeps the original body pipe.
class ResponseBodyFollow {
 public:
  ~ResponseBodyFollow();

  static std::unique_ptr<ResponseBodyFollow> MaybeCreate(InterceptState* state,
                                                         const GURL& url);

  void OnRedirect(const std::string& from_url,
                  const net::RedirectInfo& redirect_info);
  mojo::ScopedDataPipeConsumerHandle OnResponse(
      network::mojom::URLResponseHead* head,
      const std::string& url,
      mojo::ScopedDataPipeConsumerHandle body);
  void OnNetworkComplete(int error_code);

  ResponseBodyFollow(const ResponseBodyFollow&) = delete;
  ResponseBodyFollow& operator=(const ResponseBodyFollow&) = delete;

 private:
  class State;
  explicit ResponseBodyFollow(std::unique_ptr<State> state);

  std::unique_ptr<State> state_;
};

// Inserts a loader hop that tees the response body. Used only after
// MaybeCreate returns a follow, so the direct path stays untouched when this
// is not called.
void StartResponseBodyLoader(
    std::unique_ptr<ResponseBodyFollow> follow,
    mojo::PendingReceiver<network::mojom::URLLoader> loader,
    int32_t request_id,
    uint32_t options,
    const network::ResourceRequest& request,
    mojo::PendingRemote<network::mojom::URLLoaderClient> client,
    const net::MutableNetworkTrafficAnnotationTag& traffic_annotation,
    network::mojom::URLLoaderFactory* target);

}  // namespace electron

#endif  // ELECTRON_SHELL_BROWSER_NET_RESPONSE_BODY_OBSERVER_H_

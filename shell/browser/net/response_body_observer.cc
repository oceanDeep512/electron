// Copyright (c) 2026 GitHub, Inc.
// Use of this source code is governed by the MIT license that can be
// found in the LICENSE file.

#include "shell/browser/net/response_body_observer.h"

#include <stddef.h>

#include <algorithm>
#include <optional>
#include <utility>

#include "base/check.h"
#include "base/containers/span.h"
#include "base/functional/bind.h"
#include "base/memory/ref_counted.h"
#include "base/memory/weak_ptr.h"
#include "base/strings/string_number_conversions.h"
#include "base/synchronization/lock.h"
#include "base/task/sequenced_task_runner.h"
#include "content/public/browser/browser_task_traits.h"
#include "content/public/browser/browser_thread.h"
#include "mojo/public/cpp/base/big_buffer.h"
#include "mojo/public/cpp/bindings/receiver.h"
#include "mojo/public/cpp/bindings/remote.h"
#include "mojo/public/cpp/system/simple_watcher.h"
#include "net/base/net_errors.h"
#include "net/http/http_response_headers.h"
#include "net/url_request/redirect_info.h"
#include "services/network/public/cpp/http_request_headers_update_params.h"
#include "services/network/public/cpp/resource_request.h"
#include "services/network/public/cpp/url_loader_completion_status.h"
#include "services/network/public/mojom/early_hints.mojom.h"
#include "services/network/public/mojom/url_loader.mojom.h"
#include "services/network/public/mojom/url_loader_factory.mojom.h"
#include "services/network/public/mojom/url_response_head.mojom.h"
#include "shell/browser/net/url_loader_factory_gate.h"
#include "shell/common/node_util.h"
#include "url/gurl.h"
#include "v8/include/v8.h"

namespace electron {
namespace {

constexpr size_t kTeeReadBytes = 16 * 1024;
constexpr uint32_t kTeePipeCapacity = 64 * 1024;

bool UrlMatches(const std::vector<std::string>& patterns, const GURL& url) {
  if (!url.SchemeIsHTTPOrHTTPS())
    return false;
  if (patterns.empty())
    return true;
  const std::string& spec = url.spec();
  for (const std::string& pattern : patterns) {
    const size_t star = pattern.find('*');
    if (star == std::string::npos) {
      if (spec.compare(0, pattern.size(), pattern) == 0)
        return true;
      continue;
    }
    const size_t suffix_size = pattern.size() - star - 1;
    if (spec.size() < star + suffix_size)
      continue;
    if (spec.compare(0, star, pattern, 0, star) != 0)
      continue;
    if (spec.compare(spec.size() - suffix_size, suffix_size, pattern, star + 1,
                     suffix_size) != 0)
      continue;
    return true;
  }
  return false;
}

size_t ClampBytes(size_t value, size_t fallback, size_t max_value) {
  if (value < 1 || value > max_value)
    return fallback;
  return value;
}

int ClampInFlight(int value) {
  if (value < 1 || value > kResponseBodyMaxInFlight)
    return kResponseBodyDefaultMaxInFlight;
  return value;
}

v8::Local<v8::String> Utf8(v8::Isolate* isolate, const std::string& value) {
  return v8::String::NewFromUtf8(isolate, value.data(),
                                 v8::NewStringType::kNormal,
                                 static_cast<int>(value.size()))
      .ToLocalChecked();
}

bool SetProp(v8::Isolate* isolate,
             v8::Local<v8::Context> context,
             v8::Local<v8::Object> object,
             const char* name,
             v8::Local<v8::Value> value) {
  return object
      ->Set(context,
            v8::String::NewFromUtf8(isolate, name, v8::NewStringType::kNormal)
                .ToLocalChecked(),
            value)
      .FromMaybe(false);
}

class ResponseBodyTee : public base::RefCountedThreadSafe<ResponseBodyTee> {
 public:
  struct Result {
    mojo::ScopedDataPipeConsumerHandle body;
    scoped_refptr<ResponseBodyTee> tee;
  };

  static Result Start(scoped_refptr<InterceptState> state,
                      const ResponseBodyTicket& ticket,
                      std::string url,
                      int status,
                      std::string mime_type,
                      bool network_decoded,
                      mojo::ScopedDataPipeConsumerHandle source) {
    Result result;
    mojo::ScopedDataPipeProducerHandle producer;
    mojo::ScopedDataPipeConsumerHandle consumer;
    MojoCreateDataPipeOptions options = {};
    options.struct_size = sizeof(MojoCreateDataPipeOptions);
    options.flags = MOJO_CREATE_DATA_PIPE_FLAG_NONE;
    options.element_num_bytes = 1;
    options.capacity_num_bytes = kTeePipeCapacity;
    if (mojo::CreateDataPipe(&options, producer, consumer) != MOJO_RESULT_OK) {
      ResponseBodyEvent failed;
      failed.phase = "skipped";
      failed.request_id = ticket.request_id;
      failed.generation = ticket.generation;
      failed.url = url;
      failed.skip_reason = "tee-failed";
      failed.has_body = false;
      state->EmitResponseBody(std::move(failed));
      state->FinishResponseBodyClaim();
      result.body = std::move(source);
      return result;
    }

    auto tee = base::MakeRefCounted<ResponseBodyTee>(
        std::move(state), ticket, std::move(url), status, std::move(mime_type),
        network_decoded, std::move(source), std::move(producer));
    tee->self_ = tee;
    tee->Arm();
    result.body = std::move(consumer);
    result.tee = tee;
    return result;
  }

  ResponseBodyTee(scoped_refptr<InterceptState> state,
                  const ResponseBodyTicket& ticket,
                  std::string url,
                  int status,
                  std::string mime_type,
                  bool network_decoded,
                  mojo::ScopedDataPipeConsumerHandle source,
                  mojo::ScopedDataPipeProducerHandle dest)
      : state_(std::move(state)),
        request_id_(ticket.request_id),
        generation_(ticket.generation),
        max_bytes_(ticket.max_bytes),
        url_(std::move(url)),
        status_(status),
        mime_type_(std::move(mime_type)),
        network_decoded_(network_decoded),
        source_(std::move(source)),
        dest_(std::move(dest)),
        readable_(FROM_HERE,
                  mojo::SimpleWatcher::ArmingPolicy::MANUAL,
                  base::SequencedTaskRunner::GetCurrentDefault()),
        writable_(FROM_HERE,
                  mojo::SimpleWatcher::ArmingPolicy::MANUAL,
                  base::SequencedTaskRunner::GetCurrentDefault()) {}

  void NoteStatus(int error_code) {
    if (status_seen_)
      return;
    status_seen_ = true;
    error_code_ = error_code;
    MaybeEmit();
  }

  void Arm() {
    readable_.Watch(source_.get(), MOJO_HANDLE_SIGNAL_READABLE,
                    base::BindRepeating(&ResponseBodyTee::OnReadable,
                                        weak_factory_.GetWeakPtr()));
    writable_.Watch(dest_.get(), MOJO_HANDLE_SIGNAL_WRITABLE,
                    base::BindRepeating(&ResponseBodyTee::OnWritable,
                                        weak_factory_.GetWeakPtr()));
    Pump();
  }

 private:
  friend class base::RefCountedThreadSafe<ResponseBodyTee>;

  ~ResponseBodyTee() {
    if (!claim_open_)
      return;
    if (!captured_.empty()) {
      state_->ReleaseResponseBodyBytes(captured_.size());
      captured_.clear();
    }
    state_->FinishResponseBodyClaim();
    claim_open_ = false;
  }

  void OnReadable(MojoResult result) {
    if (result != MOJO_RESULT_OK) {
      FailPipe();
      return;
    }
    Pump();
  }

  void OnWritable(MojoResult result) {
    if (result != MOJO_RESULT_OK) {
      FailPipe();
      return;
    }
    Pump();
  }

  // Read from the network only after the renderer pipe accepts the previous
  // chunk. `pending_` holds at most one read, so a slow renderer stops the
  // network pipe instead of growing a buffer.
  void Pump() {
    if (pipe_done_)
      return;
    for (;;) {
      if (!pending_.empty()) {
        size_t written = 0;
        const MojoResult wr = dest_->WriteData(base::as_byte_span(pending_),
                                              MOJO_WRITE_DATA_FLAG_NONE,
                                              written);
        if (wr == MOJO_RESULT_SHOULD_WAIT) {
          writable_.ArmOrNotify();
          return;
        }
        if (wr != MOJO_RESULT_OK || written == 0) {
          FailPipe();
          return;
        }
        Remember(base::as_byte_span(pending_).first(written));
        pending_.erase(pending_.begin(),
                       pending_.begin() + static_cast<std::ptrdiff_t>(written));
        continue;
      }
      if (source_done_) {
        dest_.reset();
        pipe_done_ = true;
        readable_.Cancel();
        writable_.Cancel();
        scoped_refptr<ResponseBodyTee> keep_alive = self_;
        MaybeEmit();
        return;
      }
      std::vector<uint8_t> buffer(kTeeReadBytes);
      size_t read = buffer.size();
      const MojoResult rr = source_->ReadData(
          MOJO_READ_DATA_FLAG_NONE, base::as_writable_byte_span(buffer), read);
      if (rr == MOJO_RESULT_SHOULD_WAIT) {
        readable_.ArmOrNotify();
        return;
      }
      if (rr == MOJO_RESULT_FAILED_PRECONDITION) {
        source_done_ = true;
        continue;
      }
      if (rr != MOJO_RESULT_OK || read == 0) {
        FailPipe();
        return;
      }
      buffer.resize(read);
      pending_ = std::move(buffer);
    }
  }

  void Remember(base::span<const uint8_t> bytes) {
    if (silent_ || truncated_ || bytes.empty())
      return;
    if (!state_->ResponseBodyGenerationCurrent(generation_)) {
      silent_ = true;
      if (!captured_.empty()) {
        state_->ReleaseResponseBodyBytes(captured_.size());
        captured_.clear();
      }
      return;
    }
    const size_t room =
        captured_.size() >= max_bytes_ ? 0 : max_bytes_ - captured_.size();
    const size_t accepted = state_->AcceptResponseBodyBytes(bytes.size(), room);
    if (accepted > 0) {
      captured_.insert(captured_.end(), bytes.begin(),
                       bytes.begin() + static_cast<std::ptrdiff_t>(accepted));
    }
    if (accepted < bytes.size())
      truncated_ = true;
  }

  void FailPipe() {
    if (pipe_done_)
      return;
    pipe_done_ = true;
    pipe_failed_ = true;
    readable_.Cancel();
    writable_.Cancel();
    source_.reset();
    dest_.reset();
    pending_.clear();
    scoped_refptr<ResponseBodyTee> keep_alive = self_;
    MaybeEmit();
  }

  void MaybeEmit() {
    if (emitted_ || !pipe_done_ || !status_seen_)
      return;
    emitted_ = true;
    if (silent_ || !state_->ResponseBodyGenerationCurrent(generation_)) {
      if (!captured_.empty()) {
        state_->ReleaseResponseBodyBytes(captured_.size());
        captured_.clear();
      }
      if (claim_open_) {
        state_->FinishResponseBodyClaim();
        claim_open_ = false;
      }
      self_.reset();
      return;
    }
    ResponseBodyEvent event;
    event.phase =
        (pipe_failed_ || error_code_ != net::OK) ? "aborted" : "completed";
    event.request_id = request_id_;
    event.generation = generation_;
    event.url = url_;
    event.status = status_;
    event.mime_type = mime_type_;
    event.network_decoded = network_decoded_;
    event.truncated = truncated_;
    event.error_code = pipe_failed_ && error_code_ == net::OK ? net::ERR_FAILED
                                                             : error_code_;
    event.has_body = true;
    event.buffered = captured_.size();
    event.body = std::move(captured_);
    if (claim_open_) {
      state_->FinishResponseBodyClaim();
      claim_open_ = false;
    }
    state_->EmitResponseBody(std::move(event));
    self_.reset();
  }

  const scoped_refptr<InterceptState> state_;
  const std::string request_id_;
  const uint64_t generation_;
  const size_t max_bytes_;
  const std::string url_;
  const int status_;
  const std::string mime_type_;
  const bool network_decoded_;
  mojo::ScopedDataPipeConsumerHandle source_;
  mojo::ScopedDataPipeProducerHandle dest_;
  mojo::SimpleWatcher readable_;
  mojo::SimpleWatcher writable_;
  std::vector<uint8_t> pending_;
  std::vector<uint8_t> captured_;
  scoped_refptr<ResponseBodyTee> self_;
  bool source_done_ = false;
  bool pipe_done_ = false;
  bool pipe_failed_ = false;
  bool truncated_ = false;
  bool silent_ = false;
  bool status_seen_ = false;
  bool emitted_ = false;
  bool claim_open_ = true;
  int error_code_ = net::OK;
  base::WeakPtrFactory<ResponseBodyTee> weak_factory_{this};
};

}  // namespace

class ResponseBodyListener {
 public:
  ResponseBodyListener(v8::Isolate* isolate, v8::Local<v8::Function> function)
      : isolate_(isolate), function_(isolate, function) {}

  void Deliver(const ResponseBodyEvent& event) {
    v8::Isolate* isolate = isolate_;
    if (!isolate || isolate != v8::Isolate::TryGetCurrent() ||
        function_.IsEmpty()) {
      return;
    }
    v8::HandleScope handle_scope(isolate);
    v8::Local<v8::Context> context = isolate->GetCurrentContext();
    if (context.IsEmpty())
      return;
    v8::Context::Scope context_scope(context);
    v8::Local<v8::Object> object = v8::Object::New(isolate);
    if (!SetProp(isolate, context, object, "phase", Utf8(isolate, event.phase)) ||
        !SetProp(isolate, context, object, "requestId",
                 Utf8(isolate, event.request_id)) ||
        !SetProp(isolate, context, object, "url", Utf8(isolate, event.url)) ||
        !SetProp(isolate, context, object, "redirectUrl",
                 Utf8(isolate, event.redirect_url)) ||
        !SetProp(isolate, context, object, "status",
                 v8::Integer::New(isolate, event.status)) ||
        !SetProp(isolate, context, object, "mimeType",
                 Utf8(isolate, event.mime_type)) ||
        !SetProp(isolate, context, object, "networkDecoded",
                 v8::Boolean::New(isolate, event.network_decoded)) ||
        !SetProp(isolate, context, object, "truncated",
                 v8::Boolean::New(isolate, event.truncated)) ||
        !SetProp(isolate, context, object, "skipReason",
                 Utf8(isolate, event.skip_reason)) ||
        !SetProp(isolate, context, object, "errorCode",
                 v8::Integer::New(isolate, event.error_code))) {
      return;
    }
    v8::Local<v8::Value> body = v8::Null(isolate);
    if (event.has_body) {
      v8::MaybeLocal<v8::Object> copied =
          electron::Buffer::Copy(isolate, base::span<const uint8_t>(event.body));
      if (copied.IsEmpty())
        return;
      body = copied.ToLocalChecked();
    }
    if (!SetProp(isolate, context, object, "body", body))
      return;
    v8::Local<v8::Value> arg = object;
    v8::TryCatch try_catch(isolate);
    // The exception can quote caller code. Do not read or log it: the event
    // itself may hold a response body.
    (void)function_.Get(isolate)->Call(context, v8::Undefined(isolate), 1,
                                       &arg);
  }

 private:
  v8::Isolate* isolate_;
  v8::Global<v8::Function> function_;
};

bool IsValidResponseBodyPattern(const std::string& pattern) {
  if (pattern.empty() || pattern.size() > 2048)
    return false;
  return std::count(pattern.begin(), pattern.end(), '*') <= 1;
}

std::unique_ptr<ResponseBodyListener> MakeResponseBodyListener(
    v8::Isolate* isolate,
    v8::Local<v8::Function> listener) {
  return std::make_unique<ResponseBodyListener>(isolate, listener);
}

void ConfigureResponseBodyObservation(InterceptState* state,
                                      v8::Isolate* isolate,
                                      v8::Local<v8::Function> listener,
                                      ResponseBodyLimits limits) {
  state->InstallResponseBodyListener(
      MakeResponseBodyListener(isolate, listener), std::move(limits));
}

InterceptState::~InterceptState() {
  if (!response_body_listener_)
    return;
  CHECK(content::BrowserThread::CurrentlyOn(content::BrowserThread::UI));
  response_body_listener_.reset();
}

void InterceptState::InstallResponseBodyListener(
    std::unique_ptr<ResponseBodyListener> listener,
    ResponseBodyLimits limits) {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  limits.max_bytes_per_response =
      ClampBytes(limits.max_bytes_per_response, kResponseBodyDefaultMaxBytes,
                 kResponseBodyMaxBytes);
  limits.max_in_flight = ClampInFlight(limits.max_in_flight);
  limits.max_aggregate_bytes = ClampBytes(limits.max_aggregate_bytes,
                                          kResponseBodyDefaultAggregateBytes,
                                          kResponseBodyMaxAggregateBytes);
  {
    base::AutoLock lock(lock_);
    response_limits_ = std::move(limits);
    response_enabled_ = true;
  }
  response_body_listener_ = std::move(listener);
  response_body_enabled_.store(true, std::memory_order_release);
}

void InterceptState::ClearResponseBodyObservation() {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  response_body_enabled_.store(false, std::memory_order_release);
  {
    base::AutoLock lock(lock_);
    response_enabled_ = false;
    ++response_generation_;
    response_limits_ = ResponseBodyLimits();
  }
  response_body_listener_.reset();
}

ResponseBodyTicket InterceptState::ClaimResponseBody(const GURL& url) {
  ResponseBodyTicket ticket;
  bool emit_skip = false;
  bool emit_opened = false;
  {
    base::AutoLock lock(lock_);
    if (!response_enabled_ || !UrlMatches(response_limits_.patterns, url))
      return ticket;
    ticket.request_id = base::NumberToString(++response_next_id_);
    ticket.generation = response_generation_;
    ticket.url = url.spec();
    ticket.max_bytes = response_limits_.max_bytes_per_response;
    if (response_in_flight_ >= response_limits_.max_in_flight) {
      ticket.kind = ResponseBodyClaimKind::kSkip;
      ticket.skip_reason = "in-flight-limit";
      emit_skip = true;
    } else if (response_aggregate_ >= response_limits_.max_aggregate_bytes) {
      ticket.kind = ResponseBodyClaimKind::kSkip;
      ticket.skip_reason = "aggregate-limit";
      emit_skip = true;
    } else {
      ++response_in_flight_;
      ticket.kind = ResponseBodyClaimKind::kClaim;
      emit_opened = true;
    }
  }
  if (!emit_skip && !emit_opened)
    return ticket;
  ResponseBodyEvent event;
  event.phase = emit_skip ? "skipped" : "opened";
  event.request_id = ticket.request_id;
  event.generation = ticket.generation;
  event.url = ticket.url;
  event.skip_reason = ticket.skip_reason;
  event.has_body = false;
  EmitResponseBody(std::move(event));
  return ticket;
}

void InterceptState::FinishResponseBodyClaim() {
  base::AutoLock lock(lock_);
  if (response_in_flight_ > 0)
    --response_in_flight_;
}

size_t InterceptState::AcceptResponseBodyBytes(size_t want, size_t local_room) {
  base::AutoLock lock(lock_);
  size_t allowed = std::min(want, local_room);
  const size_t space =
      response_aggregate_ < response_limits_.max_aggregate_bytes
          ? response_limits_.max_aggregate_bytes - response_aggregate_
          : 0;
  allowed = std::min(allowed, space);
  response_aggregate_ += allowed;
  return allowed;
}

void InterceptState::ReleaseResponseBodyBytes(size_t bytes) {
  base::AutoLock lock(lock_);
  if (bytes > response_aggregate_)
    response_aggregate_ = 0;
  else
    response_aggregate_ -= bytes;
}

bool InterceptState::ResponseBodyGenerationCurrent(uint64_t generation) const {
  base::AutoLock lock(lock_);
  return response_enabled_ && generation == response_generation_;
}

void InterceptState::EmitResponseBody(ResponseBodyEvent event) {
  content::GetUIThreadTaskRunner({})->PostTask(
      FROM_HERE, base::BindOnce(&InterceptState::DeliverResponseBody,
                                scoped_refptr<InterceptState>(this),
                                std::move(event)));
}

void InterceptState::DeliverResponseBody(ResponseBodyEvent event) {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  if (event.buffered)
    ReleaseResponseBodyBytes(event.buffered);
  if (!response_body_listener_)
    return;
  bool current = false;
  {
    base::AutoLock lock(lock_);
    current = response_enabled_ && event.generation == response_generation_;
  }
  if (!current)
    return;
  response_body_listener_->Deliver(event);
}

class ResponseBodyFollow::State {
 public:
  State(scoped_refptr<InterceptState> state, ResponseBodyTicket ticket)
      : intercept(std::move(state)), ticket(std::move(ticket)) {}

  void AbortIfOpen() {
    if (detached)
      return;
    if (tee) {
      tee->NoteStatus(net::ERR_ABORTED);
      tee.reset();
      detached = true;
      return;
    }
    EmitTerminal(net::ERR_ABORTED, false);
  }

  void OnRedirect(const std::string& from_url,
                  const net::RedirectInfo& redirect_info) {
    if (detached)
      return;
    ResponseBodyEvent event;
    event.phase = "redirect";
    event.request_id = ticket.request_id;
    event.generation = ticket.generation;
    event.url = from_url;
    event.redirect_url = redirect_info.new_url.spec();
    event.status = redirect_info.status_code;
    event.has_body = false;
    intercept->EmitResponseBody(std::move(event));
  }

  mojo::ScopedDataPipeConsumerHandle OnResponse(
      network::mojom::URLResponseHead* head,
      const std::string& url,
      mojo::ScopedDataPipeConsumerHandle body) {
    url_ = url;
    if (head) {
      if (head->headers)
        status_ = head->headers->response_code();
      mime_type_ = head->mime_type;
      network_decoded_ = head->client_side_content_decoding_types.empty();
    }
    if (!body.is_valid()) {
      empty_body_ = true;
      return body;
    }
    ResponseBodyTee::Result started = ResponseBodyTee::Start(
        intercept, ticket, url_, status_, mime_type_, network_decoded_,
        std::move(body));
    if (!started.tee) {
      // Start emitted tee-failed and released the claim.
      detached = true;
      return std::move(started.body);
    }
    tee = std::move(started.tee);
    return std::move(started.body);
  }

  scoped_refptr<InterceptState> intercept;
  ResponseBodyTicket ticket;
  scoped_refptr<ResponseBodyTee> tee;
  bool detached = false;
  bool empty_body_ = false;
  int status_ = 0;
  std::string mime_type_;
  bool network_decoded_ = true;
  std::string url_;

  void OnNetworkComplete(int error_code) {
    if (detached)
      return;
    if (tee) {
      tee->NoteStatus(error_code);
      tee.reset();
      detached = true;
      return;
    }
    EmitTerminal(error_code, empty_body_ || true);
  }

 private:
  void EmitTerminal(int error_code, bool) {
    ResponseBodyEvent event;
    event.phase = error_code == net::OK ? "completed" : "aborted";
    event.request_id = ticket.request_id;
    event.generation = ticket.generation;
    event.url = url_.empty() ? ticket.url : url_;
    event.status = status_;
    event.mime_type = mime_type_;
    event.network_decoded = network_decoded_;
    event.error_code = error_code;
    event.has_body = true;
    intercept->EmitResponseBody(std::move(event));
    intercept->FinishResponseBodyClaim();
    detached = true;
  }
};

ResponseBodyFollow::ResponseBodyFollow(std::unique_ptr<State> state)
    : state_(std::move(state)) {}

ResponseBodyFollow::~ResponseBodyFollow() {
  if (state_)
    state_->AbortIfOpen();
}

std::unique_ptr<ResponseBodyFollow> ResponseBodyFollow::MaybeCreate(
    InterceptState* intercept,
    const GURL& url) {
  if (!intercept || !intercept->response_body_enabled())
    return nullptr;
  ResponseBodyTicket ticket = intercept->ClaimResponseBody(url);
  if (ticket.kind != ResponseBodyClaimKind::kClaim)
    return nullptr;
  return std::unique_ptr<ResponseBodyFollow>(new ResponseBodyFollow(
      std::make_unique<State>(intercept, std::move(ticket))));
}

void ResponseBodyFollow::OnRedirect(const std::string& from_url,
                                    const net::RedirectInfo& redirect_info) {
  state_->OnRedirect(from_url, redirect_info);
}

mojo::ScopedDataPipeConsumerHandle ResponseBodyFollow::OnResponse(
    network::mojom::URLResponseHead* head,
    const std::string& url,
    mojo::ScopedDataPipeConsumerHandle body) {
  return state_->OnResponse(head, url, std::move(body));
}

void ResponseBodyFollow::OnNetworkComplete(int error_code) {
  state_->OnNetworkComplete(error_code);
}

namespace {

class ResponseBodyURLLoader : public network::mojom::URLLoader,
                              public network::mojom::URLLoaderClient {
 public:
  ResponseBodyURLLoader(
      std::unique_ptr<ResponseBodyFollow> follow,
      std::string url,
      mojo::PendingReceiver<network::mojom::URLLoader> renderer_loader,
      mojo::PendingRemote<network::mojom::URLLoaderClient> renderer_client,
      network::mojom::URLLoaderClientEndpointsPtr network_endpoints)
      : follow_(std::move(follow)),
        current_url_(std::move(url)),
        renderer_loader_receiver_(this, std::move(renderer_loader)),
        renderer_client_(std::move(renderer_client)),
        network_loader_(std::move(network_endpoints->url_loader)),
        network_client_receiver_(this,
                                 std::move(network_endpoints->url_loader_client)) {
    renderer_loader_receiver_.set_disconnect_handler(base::BindOnce(
        &ResponseBodyURLLoader::Finish, weak_factory_.GetWeakPtr()));
    renderer_client_.set_disconnect_handler(base::BindOnce(
        &ResponseBodyURLLoader::Finish, weak_factory_.GetWeakPtr()));
    network_client_receiver_.set_disconnect_handler(base::BindOnce(
        &ResponseBodyURLLoader::Finish, weak_factory_.GetWeakPtr()));
  }

  ~ResponseBodyURLLoader() override = default;

 private:
  void FollowRedirect(
      network::HttpRequestHeadersUpdateParams headers_update_params,
      const std::optional<GURL>& new_url) override {
    network_loader_->FollowRedirect(std::move(headers_update_params), new_url);
  }

  void SetPriority(net::RequestPriority priority,
                   int32_t intra_priority_value) override {
    network_loader_->SetPriority(priority, intra_priority_value);
  }

  void OnReceiveEarlyHints(network::mojom::EarlyHintsPtr early_hints) override {
    renderer_client_->OnReceiveEarlyHints(std::move(early_hints));
  }

  void OnReceiveResponse(
      network::mojom::URLResponseHeadPtr head,
      mojo::ScopedDataPipeConsumerHandle body,
      std::optional<mojo_base::BigBuffer> cached_metadata) override {
    body = follow_->OnResponse(head.get(), current_url_, std::move(body));
    renderer_client_->OnReceiveResponse(std::move(head), std::move(body),
                                        std::move(cached_metadata));
  }

  void OnReceiveRedirect(const net::RedirectInfo& redirect_info,
                         network::mojom::URLResponseHeadPtr head) override {
    follow_->OnRedirect(current_url_, redirect_info);
    current_url_ = redirect_info.new_url.spec();
    renderer_client_->OnReceiveRedirect(redirect_info, std::move(head));
  }

  void OnUploadProgress(int64_t current_position,
                        int64_t total_size,
                        OnUploadProgressCallback callback) override {
    renderer_client_->OnUploadProgress(current_position, total_size,
                                       std::move(callback));
  }

  void OnTransferSizeUpdated(int32_t transfer_size_diff) override {
    renderer_client_->OnTransferSizeUpdated(transfer_size_diff);
  }

  void OnComplete(const network::URLLoaderCompletionStatus& status) override {
    follow_->OnNetworkComplete(status.error_code);
    renderer_client_->OnComplete(status);
    Finish();
  }

  void Finish() {
    if (finished_)
      return;
    finished_ = true;
    delete this;
  }

  std::unique_ptr<ResponseBodyFollow> follow_;
  std::string current_url_;
  mojo::Receiver<network::mojom::URLLoader> renderer_loader_receiver_;
  mojo::Remote<network::mojom::URLLoaderClient> renderer_client_;
  mojo::Remote<network::mojom::URLLoader> network_loader_;
  mojo::Receiver<network::mojom::URLLoaderClient> network_client_receiver_;
  bool finished_ = false;
  base::WeakPtrFactory<ResponseBodyURLLoader> weak_factory_{this};
};

}  // namespace

void StartResponseBodyLoader(
    std::unique_ptr<ResponseBodyFollow> follow,
    mojo::PendingReceiver<network::mojom::URLLoader> loader,
    int32_t request_id,
    uint32_t options,
    const network::ResourceRequest& request,
    mojo::PendingRemote<network::mojom::URLLoaderClient> client,
    const net::MutableNetworkTrafficAnnotationTag& traffic_annotation,
    network::mojom::URLLoaderFactory* target) {
  const std::string url = request.url.spec();
  mojo::PendingRemote<network::mojom::URLLoader> network_loader;
  auto network_loader_receiver = network_loader.InitWithNewPipeAndPassReceiver();
  mojo::PendingRemote<network::mojom::URLLoaderClient> network_client;
  auto network_endpoints = network::mojom::URLLoaderClientEndpoints::New(
      std::move(network_loader),
      network_client.InitWithNewPipeAndPassReceiver());
  new ResponseBodyURLLoader(std::move(follow), url, std::move(loader),
                            std::move(client), std::move(network_endpoints));
  target->CreateLoaderAndStart(std::move(network_loader_receiver), request_id,
                               options, request, std::move(network_client),
                               traffic_annotation);
}

}  // namespace electron

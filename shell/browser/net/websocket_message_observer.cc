// Copyright (c) 2026 GitHub, Inc.
// Use of this source code is governed by the MIT license that can be
// found in the LICENSE file.

#include "shell/browser/net/websocket_message_observer.h"

#include <stddef.h>

#include <algorithm>
#include <utility>

#include "base/containers/span.h"
#include "base/functional/bind.h"
#include "base/memory/scoped_refptr.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "base/task/sequenced_task_runner.h"
#include "content/public/browser/browser_task_traits.h"
#include "content/public/browser/browser_thread.h"
#include "mojo/public/cpp/bindings/receiver.h"
#include "mojo/public/cpp/bindings/remote.h"
#include "mojo/public/cpp/system/simple_watcher.h"
#include "net/base/net_errors.h"
#include "shell/browser/javascript_environment.h"
#include "shell/common/gin_helper/locker.h"
#include "shell/common/gin_helper/node_entry_scope.h"
#include "shell/common/node_util.h"
#include "url/gurl.h"
#include "v8/include/v8-microtask-queue.h"
#include "v8/include/v8.h"

namespace electron {
namespace {

constexpr size_t kReadBytes = 16 * 1024;
constexpr uint32_t kPipeCapacity = 64 * 1024;

bool UrlMatches(const std::vector<std::string>& patterns, const GURL& url) {
  if (!url.SchemeIsWSOrWSS())
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
  if (value < 1 || value > kWebSocketMaxInFlight)
    return kWebSocketDefaultMaxInFlight;
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

const char* OpcodeName(network::mojom::WebSocketMessageType type) {
  switch (type) {
    case network::mojom::WebSocketMessageType::TEXT:
      return "text";
    case network::mojom::WebSocketMessageType::BINARY:
      return "binary";
    case network::mojom::WebSocketMessageType::CONTINUATION:
      return "continuation";
  }
  return "";
}

}  // namespace

class WebSocketListener {
 public:
  WebSocketListener(v8::Isolate* isolate, v8::Local<v8::Function> function)
      : function_(isolate, function) {}

  void Deliver(const WebSocketEvent& event) {
    v8::Isolate* isolate = JavascriptEnvironment::GetIsolate();
    if (!isolate || function_.IsEmpty())
      return;
    gin_helper::Locker locker(isolate);
    v8::Isolate::Scope isolate_scope(isolate);
    v8::HandleScope handle_scope(isolate);
    v8::Local<v8::Function> function = function_.Get(isolate);
    v8::Local<v8::Context> context;
    if (!function->GetCreationContext().ToLocal(&context))
      return;
    v8::Context::Scope context_scope(context);
    gin_helper::NodeEntryScope node_scope(context, function);
    v8::MicrotasksScope microtasks_scope(
        context, v8::MicrotasksScope::kRunMicrotasks);
    v8::Local<v8::Object> object = v8::Object::New(isolate);
    v8::Local<v8::Value> text = v8::Null(isolate);
    if (event.has_text)
      text = Utf8(isolate, event.text);
    if (!SetProp(isolate, context, object, "phase", Utf8(isolate, event.phase)) ||
        !SetProp(isolate, context, object, "connectionId",
                 Utf8(isolate, event.connection_id)) ||
        !SetProp(isolate, context, object, "messageId",
                 Utf8(isolate, event.message_id)) ||
        !SetProp(isolate, context, object, "url", Utf8(isolate, event.url)) ||
        !SetProp(isolate, context, object, "direction",
                 Utf8(isolate, event.direction)) ||
        !SetProp(isolate, context, object, "opcode",
                 Utf8(isolate, event.opcode)) ||
        !SetProp(isolate, context, object, "truncated",
                 v8::Boolean::New(isolate, event.truncated)) ||
        !SetProp(isolate, context, object, "text", text) ||
        !SetProp(isolate, context, object, "skipReason",
                 Utf8(isolate, event.skip_reason)) ||
        !SetProp(isolate, context, object, "wireCompressed",
                 v8::Boolean::New(isolate, event.wire_compressed)) ||
        !SetProp(isolate, context, object, "wasClean",
                 v8::Boolean::New(isolate, event.was_clean)) ||
        !SetProp(isolate, context, object, "code",
                 v8::Integer::New(isolate, event.code)) ||
        !SetProp(isolate, context, object, "reason",
                 Utf8(isolate, event.reason)) ||
        !SetProp(isolate, context, object, "errorCode",
                 v8::Integer::New(isolate, event.error_code)) ||
        !SetProp(isolate, context, object, "queueDropped",
                 v8::Integer::New(isolate, event.queue_dropped))) {
      return;
    }
    v8::Local<v8::Value> body = v8::Null(isolate);
    if (event.has_body) {
      v8::MaybeLocal<v8::Object> copied = electron::Buffer::Copy(
          isolate, base::span<const uint8_t>(event.body));
      if (copied.IsEmpty())
        return;
      body = copied.ToLocalChecked();
    }
    if (!SetProp(isolate, context, object, "body", body))
      return;
    v8::Local<v8::Value> arg = object;
    v8::TryCatch try_catch(isolate);
    (void)function->Call(context, v8::Undefined(isolate), 1, &arg);
  }

 private:
  v8::Global<v8::Function> function_;
};

struct FrameExpect {
  bool fin = false;
  bool observe = true;
  network::mojom::WebSocketMessageType type =
      network::mojom::WebSocketMessageType::BINARY;
  uint64_t remaining = 0;
};

class WebSocketMessageForwarder
    : public base::RefCountedThreadSafe<WebSocketMessageForwarder>,
      public network::mojom::WebSocket,
      public network::mojom::WebSocketClient {
 public:
  WebSocketMessageForwarder(
      scoped_refptr<InterceptState> state,
      WebSocketTicket ticket,
      bool wire_compressed,
      mojo::PendingRemote<network::mojom::WebSocket> network_socket,
      mojo::PendingReceiver<network::mojom::WebSocketClient> network_client,
      mojo::ScopedDataPipeConsumerHandle incoming,
      mojo::ScopedDataPipeProducerHandle outgoing)
      : state_(std::move(state)),
        ticket_(std::move(ticket)),
        wire_compressed_(wire_compressed),
        network_socket_(std::move(network_socket)),
        network_client_(this, std::move(network_client)),
        incoming_(std::move(incoming)),
        outgoing_(std::move(outgoing)),
        incoming_readable_(FROM_HERE,
                           mojo::SimpleWatcher::ArmingPolicy::MANUAL,
                           base::SequencedTaskRunner::GetCurrentDefault()),
        incoming_writable_(FROM_HERE,
                           mojo::SimpleWatcher::ArmingPolicy::MANUAL,
                           base::SequencedTaskRunner::GetCurrentDefault()),
        outgoing_readable_(FROM_HERE,
                           mojo::SimpleWatcher::ArmingPolicy::MANUAL,
                           base::SequencedTaskRunner::GetCurrentDefault()),
        outgoing_writable_(FROM_HERE,
                           mojo::SimpleWatcher::ArmingPolicy::MANUAL,
                           base::SequencedTaskRunner::GetCurrentDefault()) {
    mojo::PendingRemote<network::mojom::WebSocket> renderer_socket;
    renderer_socket_receiver_ = std::make_unique<mojo::Receiver<network::mojom::WebSocket>>(
        this, renderer_socket.InitWithNewPipeAndPassReceiver());
    renderer_socket_ = std::move(renderer_socket);
    renderer_client_receiver_ =
        renderer_client_.BindNewPipeAndPassReceiver();

    MojoCreateDataPipeOptions options = {};
    options.struct_size = sizeof(MojoCreateDataPipeOptions);
    options.flags = MOJO_CREATE_DATA_PIPE_FLAG_NONE;
    options.element_num_bytes = 1;
    options.capacity_num_bytes = kPipeCapacity;
    mojo::CreateDataPipe(&options, renderer_outgoing_producer_,
                         renderer_outgoing_);
    mojo::CreateDataPipe(&options, renderer_incoming_producer_,
                         renderer_incoming_);
  }

  bool pipes_ok() const {
    return renderer_outgoing_ && renderer_incoming_producer_;
  }

  mojo::PendingRemote<network::mojom::WebSocket> TakeSocket() {
    return std::move(renderer_socket_);
  }
  mojo::PendingReceiver<network::mojom::WebSocketClient> TakeClientReceiver() {
    return std::move(renderer_client_receiver_);
  }
  mojo::ScopedDataPipeConsumerHandle TakeReadable() {
    return std::move(renderer_incoming_);
  }
  mojo::ScopedDataPipeProducerHandle TakeWritable() {
    return std::move(renderer_outgoing_producer_);
  }
  mojo::PendingRemote<network::mojom::WebSocket> UnbindNetworkSocket() {
    return network_socket_.Unbind();
  }
  mojo::PendingReceiver<network::mojom::WebSocketClient> UnbindNetworkClient() {
    return network_client_.Unbind();
  }
  mojo::ScopedDataPipeConsumerHandle TakeNetworkReadable() {
    return std::move(incoming_);
  }
  mojo::ScopedDataPipeProducerHandle TakeNetworkWritable() {
    return std::move(outgoing_);
  }

  void Start() {
    self_ = this;
    network_client_.set_disconnect_handler(base::BindOnce(
        &WebSocketMessageForwarder::OnNetworkGone, weak_factory_.GetWeakPtr()));
    renderer_socket_receiver_->set_disconnect_handler(base::BindOnce(
        &WebSocketMessageForwarder::OnRendererGone, weak_factory_.GetWeakPtr()));
    renderer_client_.set_disconnect_handler(base::BindOnce(
        &WebSocketMessageForwarder::OnRendererGone, weak_factory_.GetWeakPtr()));
    incoming_readable_.Watch(
        incoming_.get(), MOJO_HANDLE_SIGNAL_READABLE,
        base::BindRepeating(&WebSocketMessageForwarder::OnIncomingReadable,
                            weak_factory_.GetWeakPtr()));
    incoming_writable_.Watch(
        renderer_incoming_producer_.get(), MOJO_HANDLE_SIGNAL_WRITABLE,
        base::BindRepeating(&WebSocketMessageForwarder::OnIncomingWritable,
                            weak_factory_.GetWeakPtr()));
    outgoing_readable_.Watch(
        renderer_outgoing_.get(), MOJO_HANDLE_SIGNAL_READABLE,
        base::BindRepeating(&WebSocketMessageForwarder::OnOutgoingReadable,
                            weak_factory_.GetWeakPtr()));
    outgoing_writable_.Watch(
        outgoing_.get(), MOJO_HANDLE_SIGNAL_WRITABLE,
        base::BindRepeating(&WebSocketMessageForwarder::OnOutgoingWritable,
                            weak_factory_.GetWeakPtr()));
  }

  void SendMessage(network::mojom::WebSocketMessageType type,
                   uint64_t data_length) override {
    scoped_refptr<WebSocketMessageForwarder> keep(this);
    if (shut_ || !network_socket_)
      return;
    network_socket_->SendMessage(type, data_length);
    // A continuation SendMessage is not a message the network service accepts.
    // The renderer may still write data_length bytes, so the pipe has to be
    // drained and forwarded. Those bytes are not assembled into an event.
    const bool observe =
        type != network::mojom::WebSocketMessageType::CONTINUATION;
    outgoing_frames_.push_back(FrameExpect{true, observe, type, data_length});
    PumpOutgoing();
  }

  void StartReceiving() override {
    if (shut_ || !network_socket_)
      return;
    network_socket_->StartReceiving();
  }

  void StartClosingHandshake(uint16_t code, const std::string& reason) override {
    if (shut_ || !network_socket_)
      return;
    network_socket_->StartClosingHandshake(code, reason);
  }

  void OnDataFrame(bool fin,
                   network::mojom::WebSocketMessageType type,
                   uint64_t data_length) override {
    scoped_refptr<WebSocketMessageForwarder> keep(this);
    if (shut_)
      return;
    if (renderer_client_)
      renderer_client_->OnDataFrame(fin, type, data_length);
    incoming_frames_.push_back(FrameExpect{fin, true, type, data_length});
    PumpIncoming();
  }

  void OnDropChannel(bool was_clean,
                     uint16_t code,
                     const std::string& reason) override {
    scoped_refptr<WebSocketMessageForwarder> keep(this);
    if (renderer_client_)
      renderer_client_->OnDropChannel(was_clean, code, reason);
    WebSocketEvent event;
    event.phase = "closed";
    event.was_clean = was_clean;
    event.code = code;
    event.reason = reason;
    Shutdown(std::move(event));
  }

  void OnClosingHandshake() override {
    if (shut_ || !renderer_client_)
      return;
    renderer_client_->OnClosingHandshake();
  }

 private:
  friend class base::RefCountedThreadSafe<WebSocketMessageForwarder>;
  ~WebSocketMessageForwarder() {
    // Shutdown() already finished a live forwarder. A pipe that never started
    // still holds the claim until this destructor.
    if (!claim_open_)
      return;
    WebSocketObservation* observation = state_->websocket_observation();
    if (observation) {
      observation->Release(incoming_message_.size());
      observation->Release(outgoing_message_.size());
      observation->Finish();
    }
    claim_open_ = false;
  }

  void OnIncomingReadable(MojoResult result) {
    scoped_refptr<WebSocketMessageForwarder> keep(this);
    if (result != MOJO_RESULT_OK) {
      Fail(net::ERR_FAILED);
      return;
    }
    PumpIncoming();
  }
  void OnIncomingWritable(MojoResult result) {
    scoped_refptr<WebSocketMessageForwarder> keep(this);
    if (result != MOJO_RESULT_OK) {
      Fail(net::ERR_FAILED);
      return;
    }
    PumpIncoming();
  }
  void OnOutgoingReadable(MojoResult result) {
    scoped_refptr<WebSocketMessageForwarder> keep(this);
    if (result != MOJO_RESULT_OK) {
      Fail(net::ERR_FAILED);
      return;
    }
    PumpOutgoing();
  }
  void OnOutgoingWritable(MojoResult result) {
    scoped_refptr<WebSocketMessageForwarder> keep(this);
    if (result != MOJO_RESULT_OK) {
      Fail(net::ERR_FAILED);
      return;
    }
    PumpOutgoing();
  }
  void OnNetworkGone() {
    scoped_refptr<WebSocketMessageForwarder> keep(this);
    Fail(net::ERR_CONNECTION_RESET);
  }
  void OnRendererGone() {
    scoped_refptr<WebSocketMessageForwarder> keep(this);
    Fail(net::ERR_ABORTED);
  }

  void PumpIncoming() {
    if (shut_)
      return;
    for (;;) {
      if (!incoming_pending_.empty()) {
        size_t written = 0;
        const MojoResult wr = renderer_incoming_producer_->WriteData(
            base::as_byte_span(incoming_pending_), MOJO_WRITE_DATA_FLAG_NONE,
            written);
        if (wr == MOJO_RESULT_SHOULD_WAIT) {
          incoming_writable_.ArmOrNotify();
          return;
        }
        if (wr != MOJO_RESULT_OK || written == 0) {
          Fail(net::ERR_FAILED);
          return;
        }
        Note(incoming_frames_, incoming_message_, incoming_started_,
             incoming_opcode_, incoming_truncated_,
             base::as_byte_span(incoming_pending_).first(written));
        incoming_pending_.erase(
            incoming_pending_.begin(),
            incoming_pending_.begin() + static_cast<std::ptrdiff_t>(written));
        continue;
      }
      if (!incoming_frames_.empty() && incoming_frames_.front().remaining == 0) {
        FinishIncomingFrame();
        continue;
      }
      if (incoming_frames_.empty())
        return;
      std::vector<uint8_t> buffer(kReadBytes);
      size_t read = static_cast<size_t>(
          std::min<uint64_t>(buffer.size(), incoming_frames_.front().remaining));
      buffer.resize(read);
      const MojoResult rr = incoming_->ReadData(
          MOJO_READ_DATA_FLAG_NONE, base::as_writable_byte_span(buffer), read);
      if (rr == MOJO_RESULT_SHOULD_WAIT) {
        incoming_readable_.ArmOrNotify();
        return;
      }
      if (rr != MOJO_RESULT_OK || read == 0) {
        Fail(net::ERR_FAILED);
        return;
      }
      buffer.resize(read);
      incoming_frames_.front().remaining -= read;
      incoming_pending_ = std::move(buffer);
    }
  }

  void PumpOutgoing() {
    if (shut_)
      return;
    for (;;) {
      if (!outgoing_pending_.empty()) {
        size_t written = 0;
        const MojoResult wr = outgoing_->WriteData(
            base::as_byte_span(outgoing_pending_), MOJO_WRITE_DATA_FLAG_NONE,
            written);
        if (wr == MOJO_RESULT_SHOULD_WAIT) {
          outgoing_writable_.ArmOrNotify();
          return;
        }
        if (wr != MOJO_RESULT_OK || written == 0) {
          Fail(net::ERR_FAILED);
          return;
        }
        Note(outgoing_frames_, outgoing_message_, outgoing_started_,
             outgoing_opcode_, outgoing_truncated_,
             base::as_byte_span(outgoing_pending_).first(written));
        outgoing_pending_.erase(
            outgoing_pending_.begin(),
            outgoing_pending_.begin() + static_cast<std::ptrdiff_t>(written));
        continue;
      }
      if (!outgoing_frames_.empty() && outgoing_frames_.front().remaining == 0) {
        FinishOutgoingFrame();
        continue;
      }
      if (outgoing_frames_.empty())
        return;
      std::vector<uint8_t> buffer(kReadBytes);
      size_t read = static_cast<size_t>(
          std::min<uint64_t>(buffer.size(), outgoing_frames_.front().remaining));
      buffer.resize(read);
      const MojoResult rr = renderer_outgoing_->ReadData(
          MOJO_READ_DATA_FLAG_NONE, base::as_writable_byte_span(buffer), read);
      if (rr == MOJO_RESULT_SHOULD_WAIT) {
        outgoing_readable_.ArmOrNotify();
        return;
      }
      if (rr != MOJO_RESULT_OK || read == 0) {
        Fail(net::ERR_FAILED);
        return;
      }
      buffer.resize(read);
      outgoing_frames_.front().remaining -= read;
      outgoing_pending_ = std::move(buffer);
    }
  }

  void Note(std::deque<FrameExpect>& frames,
            std::vector<uint8_t>& message,
            bool& started,
            network::mojom::WebSocketMessageType& opcode,
            bool& truncated,
            base::span<const uint8_t> bytes) {
    if (frames.empty() || bytes.empty() || !frames.front().observe)
      return;
    if (!started) {
      started = true;
      opcode = frames.front().type;
    }
    if (capturing_)
      Remember(message, truncated, bytes);
  }

  void FinishIncomingFrame() {
    if (incoming_frames_.empty())
      return;
    FrameExpect frame = incoming_frames_.front();
    if (frame.remaining != 0)
      return;
    incoming_frames_.pop_front();
    if (!incoming_started_) {
      incoming_started_ = true;
      incoming_opcode_ = frame.type;
    }
    if (frame.fin) {
      EmitMessage("received", incoming_opcode_, incoming_message_,
                  incoming_truncated_);
      incoming_started_ = false;
      incoming_message_.clear();
      incoming_truncated_ = false;
    }
  }

  void FinishOutgoingFrame() {
    if (outgoing_frames_.empty())
      return;
    FrameExpect frame = outgoing_frames_.front();
    if (frame.remaining != 0)
      return;
    outgoing_frames_.pop_front();
    if (!outgoing_started_) {
      outgoing_started_ = true;
      outgoing_opcode_ = frame.type;
    }
    if (!frame.fin)
      return;
    if (frame.observe) {
      EmitMessage("sent", outgoing_opcode_, outgoing_message_,
                  outgoing_truncated_);
    }
    outgoing_started_ = false;
    outgoing_message_.clear();
    outgoing_truncated_ = false;
  }

  void Remember(std::vector<uint8_t>& message,
                bool& truncated,
                base::span<const uint8_t> bytes) {
    WebSocketObservation* observation = state_->websocket_observation();
    if (!observation || truncated ||
        !observation->Current(ticket_.generation)) {
      DropCapture();
      return;
    }
    const size_t room =
        message.size() >= ticket_.max_bytes ? 0 : ticket_.max_bytes - message.size();
    const size_t accepted = observation->Accept(bytes.size(), room);
    if (accepted > 0) {
      message.insert(message.end(), bytes.begin(),
                     bytes.begin() + static_cast<std::ptrdiff_t>(accepted));
    }
    if (accepted < bytes.size())
      truncated = true;
  }

  void EmitMessage(const char* direction,
                   network::mojom::WebSocketMessageType opcode,
                   std::vector<uint8_t>& message,
                   bool truncated) {
    WebSocketObservation* observation = state_->websocket_observation();
    if (!capturing_ || !observation ||
        !observation->Current(ticket_.generation)) {
      DropCapture();
      return;
    }
    WebSocketEvent event;
    event.phase = "message";
    event.connection_id = ticket_.connection_id;
    event.message_id = base::NumberToString(++next_message_);
    event.generation = ticket_.generation;
    event.url = ticket_.url;
    event.direction = direction;
    event.opcode = OpcodeName(opcode);
    event.has_body = true;
    event.truncated = truncated;
    event.wire_compressed = wire_compressed_;
    event.buffered = message.size();
    event.body = std::move(message);
    message.clear();
    if (!truncated && opcode == network::mojom::WebSocketMessageType::TEXT &&
        base::IsStringUTF8(
            std::string_view(reinterpret_cast<const char*>(event.body.data()),
                             event.body.size()))) {
      event.has_text = true;
      event.text.assign(reinterpret_cast<const char*>(event.body.data()),
                        event.body.size());
    }
    observation->Emit(std::move(event), state_.get());
  }

  void DropCapture() {
    if (!capturing_)
      return;
    capturing_ = false;
    WebSocketObservation* observation = state_->websocket_observation();
    if (observation) {
      observation->Release(incoming_message_.size());
      observation->Release(outgoing_message_.size());
      if (claim_open_)
        observation->Finish();
    }
    incoming_message_.clear();
    outgoing_message_.clear();
    claim_open_ = false;
  }

  void Fail(int error) {
    WebSocketEvent event;
    event.phase = "failed";
    event.error_code = error;
    event.was_clean = false;
    Shutdown(std::move(event));
  }

  void Shutdown(WebSocketEvent terminal) {
    if (shut_)
      return;
    shut_ = true;
    incoming_readable_.Cancel();
    incoming_writable_.Cancel();
    outgoing_readable_.Cancel();
    outgoing_writable_.Cancel();
    WebSocketObservation* observation = state_->websocket_observation();
    if (capturing_ && observation &&
        observation->Current(ticket_.generation)) {
      if (incoming_started_) {
        EmitMessage("received", incoming_opcode_, incoming_message_, true);
      }
      if (outgoing_started_) {
        EmitMessage("sent", outgoing_opcode_, outgoing_message_, true);
      }
      terminal.connection_id = ticket_.connection_id;
      terminal.generation = ticket_.generation;
      terminal.url = ticket_.url;
      terminal.wire_compressed = wire_compressed_;
      observation->Emit(std::move(terminal), state_.get());
      if (claim_open_)
        observation->Finish();
      claim_open_ = false;
    } else {
      DropCapture();
    }
    network_socket_.reset();
    network_client_.reset();
    renderer_client_.reset();
    if (renderer_socket_receiver_)
      renderer_socket_receiver_->reset();
    incoming_.reset();
    outgoing_.reset();
    renderer_incoming_producer_.reset();
    renderer_outgoing_.reset();
    self_.reset();
  }

  scoped_refptr<InterceptState> state_;
  WebSocketTicket ticket_;
  bool wire_compressed_ = false;
  bool capturing_ = true;
  bool claim_open_ = true;
  bool shut_ = false;
  uint64_t next_message_ = 0;
  mojo::Remote<network::mojom::WebSocket> network_socket_;
  mojo::Receiver<network::mojom::WebSocketClient> network_client_;
  mojo::Remote<network::mojom::WebSocketClient> renderer_client_;
  std::unique_ptr<mojo::Receiver<network::mojom::WebSocket>>
      renderer_socket_receiver_;
  mojo::PendingRemote<network::mojom::WebSocket> renderer_socket_;
  mojo::PendingReceiver<network::mojom::WebSocketClient>
      renderer_client_receiver_;
  mojo::ScopedDataPipeConsumerHandle incoming_;
  mojo::ScopedDataPipeProducerHandle renderer_incoming_producer_;
  mojo::ScopedDataPipeConsumerHandle renderer_incoming_;
  mojo::ScopedDataPipeProducerHandle outgoing_;
  mojo::ScopedDataPipeProducerHandle renderer_outgoing_producer_;
  mojo::ScopedDataPipeConsumerHandle renderer_outgoing_;
  mojo::SimpleWatcher incoming_readable_;
  mojo::SimpleWatcher incoming_writable_;
  mojo::SimpleWatcher outgoing_readable_;
  mojo::SimpleWatcher outgoing_writable_;
  std::deque<FrameExpect> incoming_frames_;
  std::deque<FrameExpect> outgoing_frames_;
  std::vector<uint8_t> incoming_pending_;
  std::vector<uint8_t> outgoing_pending_;
  std::vector<uint8_t> incoming_message_;
  std::vector<uint8_t> outgoing_message_;
  bool incoming_started_ = false;
  bool outgoing_started_ = false;
  bool incoming_truncated_ = false;
  bool outgoing_truncated_ = false;
  network::mojom::WebSocketMessageType incoming_opcode_ =
      network::mojom::WebSocketMessageType::BINARY;
  network::mojom::WebSocketMessageType outgoing_opcode_ =
      network::mojom::WebSocketMessageType::BINARY;
  scoped_refptr<WebSocketMessageForwarder> self_;
  base::WeakPtrFactory<WebSocketMessageForwarder> weak_factory_{this};
};

std::unique_ptr<WebSocketListener> MakeWebSocketListener(
    v8::Isolate* isolate,
    v8::Local<v8::Function> listener) {
  return std::make_unique<WebSocketListener>(isolate, listener);
}

bool IsValidWebSocketPattern(const std::string& pattern) {
  if (pattern.empty() || pattern.size() > 2048)
    return false;
  return std::count(pattern.begin(), pattern.end(), '*') <= 1;
}

WebSocketObservation::WebSocketObservation() = default;
WebSocketObservation::~WebSocketObservation() {
  // The v8::Global listener has to be reset on the UI thread. Clear() does
  // that before the last InterceptState ref can drop on the IO thread.
  CHECK(!listener_);
}

void InterceptState::EnsureWebSocketObservation() {
  if (!websocket_)
    websocket_ = std::make_unique<WebSocketObservation>();
}

void InterceptState::ClearWebSocketObservation() {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  SetWebSocketEnabled(false);
  if (websocket_)
    websocket_->Clear(this);
}

void InterceptState::DrainWebSocketQueue() {
  if (websocket_)
    websocket_->Drain(this);
}

void WebSocketObservation::Install(std::unique_ptr<WebSocketListener> listener,
                                   WebSocketLimits limits,
                                   InterceptState* state) {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  limits.max_bytes_per_message =
      ClampBytes(limits.max_bytes_per_message, kWebSocketDefaultMaxBytes,
                 kWebSocketMaxBytes);
  limits.max_in_flight = ClampInFlight(limits.max_in_flight);
  limits.max_aggregate_bytes =
      ClampBytes(limits.max_aggregate_bytes, kWebSocketDefaultAggregateBytes,
                 kWebSocketMaxAggregateBytes);
  {
    base::AutoLock lock(lock_);
    limits_ = std::move(limits);
    enabled_ = true;
    ++generation_;
  }
  listener_ = std::move(listener);
  state->SetWebSocketEnabled(true);
}

void WebSocketObservation::UpdateLimits(WebSocketLimits limits) {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  limits.max_bytes_per_message =
      ClampBytes(limits.max_bytes_per_message, kWebSocketDefaultMaxBytes,
                 kWebSocketMaxBytes);
  limits.max_in_flight = ClampInFlight(limits.max_in_flight);
  limits.max_aggregate_bytes =
      ClampBytes(limits.max_aggregate_bytes, kWebSocketDefaultAggregateBytes,
                 kWebSocketMaxAggregateBytes);
  base::AutoLock lock(lock_);
  if (!enabled_)
    return;
  limits_ = std::move(limits);
}

void WebSocketObservation::Clear(InterceptState* state) {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  {
    base::AutoLock lock(lock_);
    enabled_ = false;
    ++generation_;
    limits_ = WebSocketLimits();
    while (!queue_.empty()) {
      WebSocketEvent dropped = std::move(queue_.front());
      queue_.pop_front();
      if (dropped.buffered) {
        if (dropped.buffered > aggregate_)
          aggregate_ = 0;
        else
          aggregate_ -= dropped.buffered;
      }
    }
    queue_dropped_ = 0;
    queue_scheduled_ = false;
  }
  listener_.reset();
  state->SetWebSocketEnabled(false);
}

WebSocketTicket WebSocketObservation::Claim(const GURL& url,
                                             InterceptState* state) {
  WebSocketTicket ticket;
  bool emit_skip = false;
  bool emit_opened = false;
  {
    base::AutoLock lock(lock_);
    if (!enabled_ || !UrlMatches(limits_.patterns, url))
      return ticket;
    ticket.connection_id = base::NumberToString(++next_id_);
    ticket.generation = generation_;
    ticket.url = url.spec();
    ticket.max_bytes = limits_.max_bytes_per_message;
    if (in_flight_ >= limits_.max_in_flight) {
      ticket.kind = WebSocketClaimKind::kSkip;
      ticket.skip_reason = "in-flight-limit";
      emit_skip = true;
    } else if (aggregate_ >= limits_.max_aggregate_bytes) {
      ticket.kind = WebSocketClaimKind::kSkip;
      ticket.skip_reason = "aggregate-limit";
      emit_skip = true;
    } else {
      ++in_flight_;
      ticket.kind = WebSocketClaimKind::kClaim;
      emit_opened = true;
    }
  }
  if (!emit_skip && !emit_opened)
    return ticket;
  WebSocketEvent event;
  event.phase = emit_skip ? "skipped" : "opened";
  event.connection_id = ticket.connection_id;
  event.generation = ticket.generation;
  event.url = ticket.url;
  event.skip_reason = ticket.skip_reason;
  Emit(std::move(event), state);
  return ticket;
}

void WebSocketObservation::Finish() {
  base::AutoLock lock(lock_);
  if (in_flight_ > 0)
    --in_flight_;
}

size_t WebSocketObservation::Accept(size_t want, size_t room) {
  base::AutoLock lock(lock_);
  size_t allowed = std::min(want, room);
  const size_t space = aggregate_ < limits_.max_aggregate_bytes
                           ? limits_.max_aggregate_bytes - aggregate_
                           : 0;
  allowed = std::min(allowed, space);
  aggregate_ += allowed;
  return allowed;
}

void WebSocketObservation::Release(size_t bytes) {
  base::AutoLock lock(lock_);
  if (bytes > aggregate_)
    aggregate_ = 0;
  else
    aggregate_ -= bytes;
}

bool WebSocketObservation::Current(uint64_t generation) const {
  base::AutoLock lock(lock_);
  return enabled_ && generation == generation_;
}

void WebSocketObservation::Emit(WebSocketEvent event, InterceptState* state) {
  bool schedule = false;
  {
    base::AutoLock lock(lock_);
    while (queue_.size() >= kWebSocketMaxQueuedEvents) {
      WebSocketEvent dropped = std::move(queue_.front());
      queue_.pop_front();
      if (dropped.buffered) {
        if (dropped.buffered > aggregate_)
          aggregate_ = 0;
        else
          aggregate_ -= dropped.buffered;
      }
      ++queue_dropped_;
    }
    queue_.push_back(std::move(event));
    if (!queue_scheduled_) {
      queue_scheduled_ = true;
      schedule = true;
    }
  }
  if (!schedule || !state)
    return;
  content::GetUIThreadTaskRunner({})->PostTask(
      FROM_HERE, base::BindOnce(&InterceptState::DrainWebSocketQueue,
                                scoped_refptr<InterceptState>(state)));
}

void WebSocketObservation::Drain(InterceptState* state) {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  constexpr int kPerTask = 8;
  for (int n = 0; n < kPerTask; ++n) {
    WebSocketEvent event;
    {
      base::AutoLock lock(lock_);
      if (queue_.empty()) {
        queue_scheduled_ = false;
        return;
      }
      event = std::move(queue_.front());
      queue_.pop_front();
      if (event.buffered) {
        if (event.buffered > aggregate_)
          aggregate_ = 0;
        else
          aggregate_ -= event.buffered;
        event.buffered = 0;
      }
      if (queue_dropped_ > 0) {
        event.queue_dropped += queue_dropped_;
        queue_dropped_ = 0;
      }
    }
    if (!listener_)
      continue;
    if (!Current(event.generation))
      continue;
    listener_->Deliver(event);
  }
  bool more = false;
  {
    base::AutoLock lock(lock_);
    more = !queue_.empty();
    queue_scheduled_ = more;
  }
  if (more && state) {
    content::GetUIThreadTaskRunner({})->PostTask(
        FROM_HERE, base::BindOnce(&InterceptState::DrainWebSocketQueue,
                                  scoped_refptr<InterceptState>(state)));
  }
}

void ConfigureWebSocketObservation(InterceptState* state,
                                   v8::Isolate* isolate,
                                   v8::Local<v8::Function> listener,
                                   WebSocketLimits limits) {
  state->EnsureWebSocketObservation();
  state->websocket_observation()->Install(
      MakeWebSocketListener(isolate, listener), std::move(limits), state);
}

void UpdateWebSocketObservationLimits(InterceptState* state,
                                      WebSocketLimits limits) {
  state->EnsureWebSocketObservation();
  state->websocket_observation()->UpdateLimits(std::move(limits));
}

void NotifyWebSocketHandshakeFailed(InterceptState* state,
                                    const GURL& url,
                                    int error_code) {
  if (!state || !state->websocket_enabled() || !state->websocket_observation())
    return;
  WebSocketTicket ticket = state->websocket_observation()->Claim(url, state);
  if (ticket.kind != WebSocketClaimKind::kClaim)
    return;
  WebSocketEvent event;
  event.phase = "failed";
  event.connection_id = ticket.connection_id;
  event.generation = ticket.generation;
  event.url = ticket.url;
  event.error_code = error_code;
  event.was_clean = false;
  state->websocket_observation()->Emit(std::move(event), state);
  state->websocket_observation()->Finish();
}

WebSocketRendererEnds ObserveWebSocketConnection(
    InterceptState* state,
    const GURL& url,
    const std::string& extensions,
    mojo::PendingRemote<network::mojom::WebSocket> socket,
    mojo::PendingReceiver<network::mojom::WebSocketClient> client_receiver,
    mojo::ScopedDataPipeConsumerHandle readable,
    mojo::ScopedDataPipeProducerHandle writable) {
  WebSocketRendererEnds ends;
  ends.socket = std::move(socket);
  ends.client_receiver = std::move(client_receiver);
  ends.readable = std::move(readable);
  ends.writable = std::move(writable);
  if (!state || !state->websocket_enabled() || !state->websocket_observation())
    return ends;
  WebSocketTicket ticket = state->websocket_observation()->Claim(url, state);
  if (ticket.kind != WebSocketClaimKind::kClaim)
    return ends;
  const bool compressed = extensions.find("permessage-deflate") != std::string::npos;
  auto forwarder = base::MakeRefCounted<WebSocketMessageForwarder>(
      state, ticket, compressed, std::move(ends.socket),
      std::move(ends.client_receiver), std::move(ends.readable),
      std::move(ends.writable));
  if (!forwarder->pipes_ok()) {
    WebSocketEvent failed;
    failed.phase = "skipped";
    failed.connection_id = ticket.connection_id;
    failed.generation = ticket.generation;
    failed.url = ticket.url;
    failed.skip_reason = "tee-failed";
    state->websocket_observation()->Emit(std::move(failed), state);
    ends.socket = forwarder->UnbindNetworkSocket();
    ends.client_receiver = forwarder->UnbindNetworkClient();
    ends.readable = forwarder->TakeNetworkReadable();
    ends.writable = forwarder->TakeNetworkWritable();
    return ends;
  }
  ends.socket = forwarder->TakeSocket();
  ends.client_receiver = forwarder->TakeClientReceiver();
  ends.readable = forwarder->TakeReadable();
  ends.writable = forwarder->TakeWritable();
  forwarder->Start();
  return ends;
}

}  // namespace electron

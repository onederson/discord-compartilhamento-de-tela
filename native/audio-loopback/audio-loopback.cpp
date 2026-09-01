// Captura PCM do áudio produzido por uma árvore de processos no Windows.
// Base conceitual: ApplicationLoopback, Microsoft Windows classic samples.
// O helper não acessa rede, arquivos ou microfone; PCM s16le 48 kHz estéreo sai
// pelo stdout e diagnósticos textuais saem pelo stderr.

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <mmdeviceapi.h>
#include <fcntl.h>
#include <io.h>
#include <tlhelp32.h>
#include <wrl/client.h>
#include <avrt.h>

#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <cwctype>
#include <deque>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_set>
#include <vector>

using Microsoft::WRL::ComPtr;

namespace {

std::atomic_bool running{true};

BOOL WINAPI onConsoleSignal(DWORD) {
  running = false;
  return TRUE;
}

std::wstring lower(std::wstring value) {
  std::transform(value.begin(), value.end(), value.begin(), towlower);
  return value;
}

struct ProcessInfo {
  DWORD pid;
  DWORD parent;
  std::wstring executable;
};

DWORD findRootProcess(const std::vector<std::wstring>& executables, std::wstring& selected) {
  const HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot == INVALID_HANDLE_VALUE) return 0;

  PROCESSENTRY32W entry{};
  entry.dwSize = sizeof(entry);
  std::vector<ProcessInfo> matches;
  std::unordered_set<std::wstring> wanted;
  for (const auto& executable : executables) wanted.insert(lower(executable));

  if (Process32FirstW(snapshot, &entry)) {
    do {
      const auto executable = lower(entry.szExeFile);
      if (wanted.contains(executable)) {
        matches.push_back({entry.th32ProcessID, entry.th32ParentProcessID, executable});
      }
    } while (Process32NextW(snapshot, &entry));
  }
  CloseHandle(snapshot);

  std::unordered_set<DWORD> ids;
  for (const auto& process : matches) ids.insert(process.pid);

  std::vector<ProcessInfo> roots;
  for (const auto& process : matches) {
    if (!ids.contains(process.parent)) roots.push_back(process);
  }
  if (roots.empty()) return 0;

  struct WindowSearch {
    const std::vector<ProcessInfo>* roots;
    DWORD result = 0;
    std::wstring executable;
  } search{&roots};

  EnumWindows(
      [](HWND window, LPARAM param) -> BOOL {
        auto* search = reinterpret_cast<WindowSearch*>(param);
        if (!IsWindowVisible(window) || GetWindow(window, GW_OWNER)) return TRUE;
        DWORD pid = 0;
        GetWindowThreadProcessId(window, &pid);
        const auto match = std::find_if(
            search->roots->begin(), search->roots->end(),
            [pid](const ProcessInfo& process) { return process.pid == pid; });
        if (match == search->roots->end()) {
          return TRUE;
        }
        search->result = pid;
        search->executable = match->executable;
        return FALSE;
      },
      reinterpret_cast<LPARAM>(&search));

  if (search.result) {
    selected = search.executable;
    return search.result;
  }
  selected = roots.front().executable;
  return roots.front().pid;
}

class ActivationHandler final : public IActivateAudioInterfaceCompletionHandler, public IAgileObject {
 public:
  ActivationHandler() : completed_(CreateEventW(nullptr, FALSE, FALSE, nullptr)) {}
  ~ActivationHandler() {
    if (completed_) CloseHandle(completed_);
  }

  HRESULT wait(ComPtr<IAudioClient>& client) {
    if (!completed_) return HRESULT_FROM_WIN32(GetLastError());
    WaitForSingleObject(completed_, INFINITE);
    if (SUCCEEDED(result_)) client = client_;
    return result_;
  }

  HRESULT STDMETHODCALLTYPE ActivateCompleted(IActivateAudioInterfaceAsyncOperation* operation) override {
    HRESULT activationResult = E_UNEXPECTED;
    ComPtr<IUnknown> unknown;
    result_ = operation->GetActivateResult(&activationResult, &unknown);
    if (SUCCEEDED(result_)) result_ = activationResult;
    if (SUCCEEDED(result_)) result_ = unknown.As(&client_);
    SetEvent(completed_);
    return S_OK;
  }

  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** object) override {
    if (!object) return E_POINTER;
    if (iid == __uuidof(IUnknown) || iid == __uuidof(IActivateAudioInterfaceCompletionHandler)) {
      *object = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
      AddRef();
      return S_OK;
    }
    if (iid == __uuidof(IAgileObject)) {
      *object = static_cast<IAgileObject*>(this);
      AddRef();
      return S_OK;
    }
    *object = nullptr;
    return E_NOINTERFACE;
  }

  ULONG STDMETHODCALLTYPE AddRef() override { return ++references_; }
  ULONG STDMETHODCALLTYPE Release() override {
    const auto remaining = --references_;
    if (!remaining) delete this;
    return remaining;
  }

 private:
  std::atomic_ulong references_{1};
  HANDLE completed_ = nullptr;
  HRESULT result_ = E_UNEXPECTED;
  ComPtr<IAudioClient> client_;
};

void printError(const wchar_t* stage, HRESULT result) {
  fwprintf(stderr, L"ERROR %ls 0x%08lX\n", stage, static_cast<unsigned long>(result));
  fflush(stderr);
}

bool writeAll(HANDLE output, const BYTE* data, DWORD bytes) {
  while (bytes && running) {
    DWORD written = 0;
    if (!WriteFile(output, data, bytes, &written, nullptr) || !written) return false;
    data += written;
    bytes -= written;
  }
  return bytes == 0;
}

// O callback de captura não pode ficar bloqueado porque o processo Node levou
// alguns milissegundos extras para ler stdout. Uma fila curta desacopla os dois
// ritmos; se ela atingir meio segundo, descarta áudio antigo em vez de aumentar
// indefinidamente o atraso de uma transmissão ao vivo.
class PcmQueue {
 public:
  static constexpr size_t kMaxBytes = 48000 * 2 * 2 / 2;

  void push(std::vector<BYTE> block) {
    std::lock_guard lock(mutex_);
    while (!blocks_.empty() && queuedBytes_ + block.size() > kMaxBytes) {
      queuedBytes_ -= blocks_.front().size();
      blocks_.pop_front();
    }
    if (block.size() > kMaxBytes) return;
    queuedBytes_ += block.size();
    blocks_.push_back(std::move(block));
    ready_.notify_one();
  }

  void finish() {
    {
      std::lock_guard lock(mutex_);
      finished_ = true;
    }
    ready_.notify_all();
  }

  void writeTo(HANDLE output) {
    while (running) {
      std::vector<BYTE> block;
      {
        std::unique_lock lock(mutex_);
        ready_.wait(lock, [this] { return finished_ || !blocks_.empty(); });
        if (blocks_.empty()) {
          if (finished_) break;
          continue;
        }
        block = std::move(blocks_.front());
        blocks_.pop_front();
        queuedBytes_ -= block.size();
      }
      if (!writeAll(output, block.data(), static_cast<DWORD>(block.size()))) {
        running = false;
        break;
      }
    }
  }

 private:
  std::mutex mutex_;
  std::condition_variable ready_;
  std::deque<std::vector<BYTE>> blocks_;
  size_t queuedBytes_ = 0;
  bool finished_ = false;
};

}  // namespace

int wmain(int argc, wchar_t** argv) {
  if (argc < 2) {
    fwprintf(stderr, L"ERROR uso: audio-loopback.exe firefox.exe [derivado.exe ...]\n");
    return 2;
  }

  std::vector<std::wstring> executables;
  for (int i = 1; i < argc; ++i) executables.emplace_back(argv[i]);
  std::wstring selected;
  const DWORD pid = findRootProcess(executables, selected);
  if (!pid) {
    fwprintf(stderr, L"ERROR processo compativel nao encontrado\n");
    return 3;
  }

  SetConsoleCtrlHandler(onConsoleSignal, TRUE);
  _setmode(_fileno(stdout), _O_BINARY);

  const HRESULT comResult = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(comResult) && comResult != RPC_E_CHANGED_MODE) {
    printError(L"CoInitializeEx", comResult);
    return 4;
  }

  auto* handler = new ActivationHandler();
  AUDIOCLIENT_ACTIVATION_PARAMS params{};
  params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  params.ProcessLoopbackParams.TargetProcessId = pid;
  params.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;

  PROPVARIANT activateParams{};
  activateParams.vt = VT_BLOB;
  activateParams.blob.cbSize = sizeof(params);
  activateParams.blob.pBlobData = reinterpret_cast<BYTE*>(&params);

  ComPtr<IActivateAudioInterfaceAsyncOperation> operation;
  HRESULT result = ActivateAudioInterfaceAsync(
      VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
      __uuidof(IAudioClient),
      &activateParams,
      handler,
      &operation);
  if (FAILED(result)) {
    printError(L"ActivateAudioInterfaceAsync", result);
    handler->Release();
    return 5;
  }

  ComPtr<IAudioClient> client;
  result = handler->wait(client);
  handler->Release();
  if (FAILED(result)) {
    printError(L"ActivateCompleted", result);
    return 6;
  }

  WAVEFORMATEX format{};
  format.wFormatTag = WAVE_FORMAT_PCM;
  format.nChannels = 2;
  format.nSamplesPerSec = 48000;
  format.wBitsPerSample = 16;
  format.nBlockAlign = format.nChannels * format.wBitsPerSample / 8;
  format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;

  const DWORD flags = AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
                      AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
  result = client->Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 0, 0, &format, nullptr);
  if (FAILED(result)) {
    printError(L"IAudioClient::Initialize", result);
    return 7;
  }

  ComPtr<IAudioCaptureClient> capture;
  result = client->GetService(IID_PPV_ARGS(&capture));
  if (FAILED(result)) {
    printError(L"IAudioClient::GetService", result);
    return 8;
  }

  const HANDLE sampleReady = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  if (!sampleReady) return 9;
  result = client->SetEventHandle(sampleReady);
  if (FAILED(result)) {
    printError(L"IAudioClient::SetEventHandle", result);
    CloseHandle(sampleReady);
    return 10;
  }

  result = client->Start();
  if (FAILED(result)) {
    printError(L"IAudioClient::Start", result);
    CloseHandle(sampleReady);
    return 11;
  }

  fwprintf(stderr, L"READY %lu %ls 48000 2 s16le\n", static_cast<unsigned long>(pid), selected.c_str());
  fflush(stderr);

  const HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
  PcmQueue pcmQueue;
  std::thread writer([&] { pcmQueue.writeTo(output); });

  // WASAPI é sensível a uma thread que perde sua janela de processamento.
  // MMCSS dá prioridade de áudio sem transformar a captura numa thread de
  // tempo real que poderia prejudicar o restante do sistema.
  DWORD mmcssTask = 0;
  HANDLE mmcss = AvSetMmThreadCharacteristicsW(L"Pro Audio", &mmcssTask);
  if (mmcss) AvSetMmThreadPriority(mmcss, AVRT_PRIORITY_HIGH);

  while (running) {
    const DWORD wait = WaitForSingleObject(sampleReady, 500);
    if (wait != WAIT_OBJECT_0 && wait != WAIT_TIMEOUT) break;
    if (wait == WAIT_TIMEOUT) continue;

    UINT32 frames = 0;
    while (running && SUCCEEDED(capture->GetNextPacketSize(&frames)) && frames > 0) {
      BYTE* data = nullptr;
      DWORD captureFlags = 0;
      UINT64 devicePosition = 0;
      UINT64 qpcPosition = 0;
      result = capture->GetBuffer(&data, &frames, &captureFlags, &devicePosition, &qpcPosition);
      if (FAILED(result)) {
        running = false;
        break;
      }

      const DWORD bytes = frames * format.nBlockAlign;
      std::vector<BYTE> block(bytes);
      if ((captureFlags & AUDCLNT_BUFFERFLAGS_SILENT) || !data) {
        std::fill(block.begin(), block.end(), static_cast<BYTE>(0));
      } else {
        std::copy_n(data, bytes, block.data());
      }

      capture->ReleaseBuffer(frames);
      pcmQueue.push(std::move(block));
    }
  }

  client->Stop();
  pcmQueue.finish();
  writer.join();
  if (mmcss) AvRevertMmThreadCharacteristics(mmcss);
  CloseHandle(sampleReady);
  if (SUCCEEDED(comResult)) CoUninitialize();
  return 0;
}

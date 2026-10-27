# Record model and runtime provenance

## 1. Keep runtime licenses distinct: model feasibility only

The application source license does not relicense external runtimes or model weights.
The pinned llama.cpp CPU server is MIT-licensed; its source and license are at
https://github.com/ggml-org/llama.cpp/tree/c7fc5094179bf8a9c73c18593db714f8da41a402.
The image is pulled from the official ghcr.io/ggml-org/llama.cpp registry and is pinned in
ai/model-lock.json. No native binary is installed.

Qwen/Qwen3-1.7B-GGUF at revision 90862c4b9d2787eaed51d12237eafdfe7c5f6077 identifies
Apache-2.0 in its official metadata and LICENSE file:
https://huggingface.co/Qwen/Qwen3-1.7B-GGUF/tree/90862c4b9d2787eaed51d12237eafdfe7c5f6077.
The downloader retains the full license with the verified official Q8_0 weights in the
private model volume. Exact weight bytes and SHA-256 are pinned in ai/model-lock.json.
Weights are downloaded directly, not committed or republished. No conversion or modified
model artifact is distributed. Recheck license/notice requirements before any public export.

## 2. Bound the costs: container-only CPU inference

Docker reports 1199917770 bytes for the chosen runtime image. The verified model file has
1834426016 bytes. These sizes do not measure incremental physical Docker disk use or caches.
Weights and private evidence remain retained after inference, while the stopped model uses
no active CPU/RAM allocation. The configured active limits are 4 GiB total memory and two CPUs.
No paid model service is configured. Port 8080 is private to the inference network.

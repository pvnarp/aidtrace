# Record model and runtime provenance

## 1. Keep runtime licenses distinct: model feasibility only

The application source license does not relicense external runtimes or model weights.
The pinned llama.cpp CPU server is MIT-licensed; its source and license are at
https://github.com/ggml-org/llama.cpp/tree/c7fc5094179bf8a9c73c18593db714f8da41a402.
The image is pulled from the official ghcr.io/ggml-org/llama.cpp registry and is pinned in
ai/model-lock.json. No native binary is installed. IAC-365 pins the immutable b11804
multi-platform index rather than its ARM-only child. It retains the exact previous
ARM64 runtime and source revision; this is not an upgrade to the floating latest server.
Index: sha256:8c74db29f1a2bef3f0a331b52c4d6214601dfceed4bee0b94cc48b3b23ff257d.
ARM64: sha256:4c153258c28d40ef1d34c265b893c57626235dc1178147d04a963c15ff9729cd.
AMD64: sha256:8badce92ec1860c764ca19c736422e81a12c65d76da57313651a7804bfe6ed40.

Qwen/Qwen3-1.7B-GGUF at revision 90862c4b9d2787eaed51d12237eafdfe7c5f6077 identifies
Apache-2.0 in its official metadata and LICENSE file:
https://huggingface.co/Qwen/Qwen3-1.7B-GGUF/tree/90862c4b9d2787eaed51d12237eafdfe7c5f6077.
The downloader retains the full license with the verified official Q8_0 weights in the
private model volume. Exact weight bytes and SHA-256 are pinned in ai/model-lock.json.
Weights are downloaded directly, not committed or republished. No conversion or modified
model artifact is distributed. Recheck license/notice requirements before any public export.

## 2. Bound the costs: container-only CPU inference

Docker reports 1199917770 bytes for ARM64 and 1224823759 bytes for AMD64. The verified model file has
1834426016 bytes. These sizes do not measure incremental physical Docker disk use or caches.
Weights and private evidence remain retained after inference, while the stopped model uses
no active CPU/RAM allocation. The configured active limits are 4 GiB total memory and two CPUs.
No paid model service is configured. Port 8080 is private to the inference network.

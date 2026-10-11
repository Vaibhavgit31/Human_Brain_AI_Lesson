This voice package contains Kokoro-JS 1.2.1 (Hexgrad / Xenova, Apache-2.0),
Transformers.js 3.5.1 as bundled by Kokoro-JS (Hugging Face, Apache-2.0),
ONNX Runtime Web 1.22.0-dev.20250409-89f8206ba4 (Microsoft, MIT),
and Phonemizer 1.2.1 (Xenova, Apache-2.0 wrapper using eSpeak NG, GPL-3.0).
The included model card identifies Kokoro-82M-v1.0-ONNX as Apache-2.0.

Upstream source and license information:

- https://github.com/hexgrad/kokoro/tree/main/kokoro.js
- https://github.com/huggingface/transformers.js/tree/3.5.1
- https://github.com/microsoft/onnxruntime/tree/89f8206ba4
- https://github.com/xenova/phonemizer.js
- https://github.com/espeak-ng/espeak-ng
- https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX

The checked-in browser package changes only Kokoro's local asset configuration:
it exposes the existing environment settings, fixes WASM to one thread and
resolves the selected voice file on this site. The exact guarded replacements
are in Tools/Voice/package_browser_voice.mjs. No upstream inference or
phonemization algorithm is modified. The independent lesson audio processing
source is Server/lib/kokoro-profile.mjs and is copied alongside the worker.

Model, voice, runtime and profile file hashes are in package-manifest.json.
Keep this notice, the accompanying license texts and source references when
redistributing these assets.

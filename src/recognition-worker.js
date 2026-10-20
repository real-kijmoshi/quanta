import { env, pipeline, RawImage } from "/vendor/transformers/transformers.min.js";

env.allowLocalModels = false;
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.wasmPaths = "/vendor/onnx/";
let current = null, currentTask = null;

self.onmessage = async ({ data: { id, task, payload } }) => {
  const progress = (message) => self.postMessage({ id, type: "progress", message });
  try {
    if (currentTask !== task) {
      await current?.dispose(); current = null; currentTask = null;
      const model = task === "handwriting" ? "Xenova/trocr-small-handwritten" : "Xenova/whisper-tiny";
      progress("Downloading recognition model for this device…");
      current = await pipeline(task === "handwriting" ? "image-to-text" : "automatic-speech-recognition", model, {
        device: "wasm", dtype: "q8",
        progress_callback: (event) => { if (event.status === "progress") progress(`Loading ${event.file}: ${Math.round(event.progress || 0)}%`); },
      });
      currentTask = task;
    }
    let result;
    if (task === "handwriting") {
      const lines = [];
      for (let i = 0; i < payload.images.length; i++) {
        progress(`Reading line ${i + 1} of ${payload.images.length}…`);
        const image = payload.images[i];
        const output = await current(new RawImage(new Uint8ClampedArray(image.data), image.width, image.height, 4), { max_new_tokens: 128 });
        lines.push(output[0]?.generated_text?.trim() || "");
      }
      result = lines.join("\n");
    } else if (task === "transcribe") {
      progress("Transcribing audio on this device…");
      const options = { chunk_length_s: 30, stride_length_s: 5, return_timestamps: true, task: "transcribe" };
      if (payload.language && payload.language !== "auto") options.language = payload.language;
      result = await current(payload.audio, options);
    } else throw new Error("Unknown recognition task");
    self.postMessage({ id, type: "result", result });
  } catch (error) { self.postMessage({ id, type: "error", message: error.message || "Recognition failed" }); }
};

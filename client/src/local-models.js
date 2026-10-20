// All inference runs on this device. Only public model downloads use the network.
let worker = null, active = null, serial = 0, idleTimer = null;

export function runLocalModel(task, payload, progress = () => {}, signal) {
  if (active) return Promise.reject(new Error("Another recognition task is running. Finish or cancel it first."));
  if (signal?.aborted) return Promise.reject(new DOMException("Cancelled", "AbortError"));
  clearTimeout(idleTimer);
  return new Promise((resolve, reject) => {
    const id = ++serial;
    const dispose = () => { worker?.terminate(); worker = null; };
    const finish = (error, value) => {
      if (!active || active.id !== id) return;
      signal?.removeEventListener("abort", abort);
      active = null;
      if (error) { dispose(); reject(error); }
      else { resolve(value); idleTimer = setTimeout(dispose, 60000); }
    };
    const abort = () => finish(new DOMException("Cancelled", "AbortError"));
    active = { id };
    try {
      worker ??= new Worker(new URL("./recognition-worker.js", import.meta.url), { type: "module" });
      worker.onmessage = ({ data }) => {
        if (data.id !== id) return;
        if (data.type === "progress") progress(data.message);
        else if (data.type === "result") finish(null, data.result);
        else if (data.type === "error") finish(new Error(data.message));
      };
      worker.onerror = (event) => finish(new Error(event.message || "Recognition could not start. Check your connection for the first model download, then retry."));
      signal?.addEventListener("abort", abort, { once: true });
      worker.postMessage({ id, task, payload });
    } catch (error) { finish(error); }
  });
}

export async function recognizePrintedText(canvas, language, progress, signal) {
  const { createWorker } = await import("/vendor/tesseract/tesseract.esm.min.js");
  if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
  let worker;
  const abort = () => worker?.terminate();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    worker = await createWorker(language, 1, {
      workerPath: "/vendor/tesseract/worker.min.js",
      corePath: "/vendor/tesseract-core",
      logger: ({ status, progress: fraction }) => progress(`${status}${Number.isFinite(fraction) ? ` ${Math.round(fraction * 100)}%` : ""}`),
    });
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    const result = await worker.recognize(canvas);
    return result.data.text.trim();
  } finally {
    signal?.removeEventListener("abort", abort);
    await worker?.terminate();
  }
}

export async function decodeAudioForRecognition(src, signal) {
  const response = await fetch(src, { signal });
  if (!response.ok) throw new Error("The recording is unavailable. Reconnect and try again.");
  const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AudioContextClass) throw new Error("This browser cannot decode audio for transcription.");
  const context = new AudioContextClass({ sampleRate: 16000 });
  try {
    const audio = await context.decodeAudioData(await response.arrayBuffer());
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    const pcm = new Float32Array(Math.ceil(audio.duration * 16000));
    const channels = Array.from({ length: audio.numberOfChannels }, (_, i) => audio.getChannelData(i));
    for (let i = 0; i < pcm.length; i++) {
      const at = i * audio.sampleRate / 16000, a = Math.floor(at), t = at - a;
      for (const channel of channels) pcm[i] += ((channel[a] || 0) * (1 - t) + (channel[a + 1] ?? channel[a] ?? 0) * t) / channels.length;
    }
    return pcm;
  } finally { await context.close(); }
}

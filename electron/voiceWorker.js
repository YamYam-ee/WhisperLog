// Körs i en egen process: räknar röstavtryck med sherpa-onnx. Om det inbyggda biblioteket
// kraschar (t.ex. på en dator där det inte fungerar) dör bara den här processen – inte appen.
let extractor = null;

function getExtractor(modelFile) {
  if (!extractor) {
    const sherpa = require('sherpa-onnx-node');
    extractor = new sherpa.SpeakerEmbeddingExtractor({ model: modelFile, numThreads: 2 });
  }
  return extractor;
}

process.on('message', (msg) => {
  try {
    if (msg.type === 'init') {
      getExtractor(msg.modelFile);
      process.send({ id: msg.id, ok: true, dim: extractor.dim });
    } else if (msg.type === 'embed') {
      if (process.env.WHISPERLOG_TEST_VOICE_CRASH) process.abort(); // endast för test av kraschskyddet
      const pcm = msg.pcm; // Int16Array
      const f = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) f[i] = pcm[i] / 32768;
      const ex = getExtractor(msg.modelFile);
      const st = ex.createStream();
      st.acceptWaveform({ samples: f, sampleRate: 16000 });
      st.inputFinished();
      process.send({ id: msg.id, emb: Array.from(ex.compute(st, false)) });
    }
  } catch (e) {
    process.send({ id: msg.id, error: String(e && e.stack ? e.stack : e) });
  }
});

process.send({ type: 'ready' });

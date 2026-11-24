import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

process.once('message', ({runtime, model, waves}) => {
  try {
    const { SpeakerEmbeddingExtractor } = require(runtime);
    const extractor = new SpeakerEmbeddingExtractor({model, numThreads:1, debug:false, provider:'cpu'});
    const embeddings = waves.map(samples => {
      if (!samples) return null;
      const stream = extractor.createStream();
      stream.acceptWaveform({samples, sampleRate:16000});
      stream.inputFinished();
      return extractor.isReady(stream) ? extractor.compute(stream, false) : null;
    });
    process.send(embeddings);
  } catch { process.exitCode = 1; }
  process.disconnect();
});

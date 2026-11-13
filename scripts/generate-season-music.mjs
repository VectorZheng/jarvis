// Original quiet pentatonic miniatures. No insect/noise samples or copyrighted recordings.
// Regenerate: node scripts/generate-season-music.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
const directory = new URL('../app/assets/audio/', import.meta.url);
mkdirSync(directory, { recursive: true });
const rate = 22050, duration = 32, count = rate * duration;
const pieces = {
  spring: { root: 60, melody: [12, 16, 19, 16, 14, 12, 9, 7, 12, 14, 16, 19, 16, 14, 12, 7], bass: [0, 5, 9, 7], decay: 2.5, overtone: 0.1 },
  summer: { root: 57, melody: [12, 7, 9, 12, 16, 14, 12, 9, 7, 9, 12, 14, 16, 12, 9, 7], bass: [0, 9, 5, 7], decay: 3.2, overtone: 0.06 },
  autumn: { root: 53, melody: [16, 14, 12, 9, 7, 9, 12, 14, 12, 9, 7, 4, 7, 9, 12, 7], bass: [0, 5, 7, 0], decay: 3.6, overtone: 0.08 },
  winter: { root: 60, melody: [19, 16, 14, 12, 16, 19, 14, 12, 9, 12, 14, 16, 14, 12, 9, 7], bass: [0, 5, 9, 0], decay: 4.2, overtone: 0.12 },
};
for (const [season, piece] of Object.entries(pieces)) {
  const samples = new Float64Array(count);
  const note = (midi, start, length, gain, decay) => {
    const frequency = 440 * 2 ** ((midi - 69) / 12);
    for (let j = 0; j < Math.floor(length * rate); j++) {
      const t = j / rate;
      const attack = 1 - Math.exp(-t / 0.05);
      const release = Math.min(1, (length - t) / 0.7);
      const envelope = attack * release * Math.exp(-t / decay);
      const fundamental = Math.sin(2 * Math.PI * frequency * t);
      const harmonic = piece.overtone * Math.sin(2 * Math.PI * frequency * 2 * t) * Math.exp(-t);
      // Wrap note tails into the next cycle for a seamless musical loop.
      const at = (Math.floor(start * rate) + j) % count;
      samples[at] += gain * envelope * (fundamental + harmonic);
    }
  };
  piece.melody.forEach((interval, index) => note(piece.root + interval, index * 2, 6, 0.16, piece.decay));
  piece.bass.forEach((interval, index) => {
    note(piece.root - 12 + interval, index * 8, 10, 0.09, 5);
    note(piece.root + 7 + interval, index * 8 + 0.5, 9, 0.035, 4);
  });
  const wav = Buffer.alloc(44 + count * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(count * 2, 40);
  let peak = 0;
  for (let i = 0; i < count; i++) {
    peak = Math.max(peak, Math.abs(samples[i]));
    wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  }
  writeFileSync(new URL(`${season}.wav`, directory), wav);
  console.log(`${season}: ${duration}s, peak=${peak.toFixed(3)}, ${wav.length} bytes`);
}

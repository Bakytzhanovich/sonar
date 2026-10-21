// "Слово за человеком": a mask of the speaker, frame by frame, so the Тема
// keyword can be drawn between the background and the person (see
// compositeBehindPerson in ffmpeg.ts).
//
// The mask comes from MODNet (assets/models), run on the CPU through
// onnxruntime — the one local model in the pipeline besides RNNoise. It runs
// only on the frames where a keyword is on screen: everywhere else nothing is
// drawn behind the speaker, so the mask there is empty and costs nothing.
//
// Written as a grayscale video at the model's resolution; ffmpeg scales it up
// to the frame and softens the edge in the same pass that uses it.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { FrameSize } from './aspect';

const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';

export const PERSON_MODEL_PATH =
  process.env.PERSON_MODEL_PATH ?? path.resolve(__dirname, '..', 'assets', 'models', 'modnet.onnx');

/** The model's short side. 288 keeps a frame under ~100 ms on two cores; the edge is softened anyway. */
const MODEL_SHORT_SIDE = 288;

export function personMaskAvailable(modelPath: string = PERSON_MODEL_PATH): boolean {
  if (!fs.existsSync(modelPath)) return false;
  try {
    require.resolve('onnxruntime-node');
    return true;
  } catch {
    return false;
  }
}

/** The model's input size for a frame: the frame's shape, short side 288, both sides multiples of 32. */
export function maskInputSize(frame: FrameSize): { width: number; height: number } {
  const scale = MODEL_SHORT_SIDE / Math.min(frame.width, frame.height);
  const to32 = (n: number) => Math.max(32, Math.round((n * scale) / 32) * 32);
  return { width: to32(frame.width), height: to32(frame.height) };
}

export interface TimeWindow {
  start: number;
  end: number;
}

/**
 * Whether frame `index` at `fps` needs a mask: inside a keyword window, with
 * one frame of slack on each side so rounding at a hard cut never leaves the
 * word's first or last frame drawn over the speaker.
 */
export function frameNeedsMask(index: number, fps: number, windows: TimeWindow[]): boolean {
  const t = index / fps;
  const slack = 1 / fps;
  return windows.some((w) => t >= w.start - slack && t < w.end + slack);
}

export interface PersonMaskOptions {
  inputPath: string;
  outputPath: string;
  frame: FrameSize;
  fps: number;
  windows: TimeWindow[];
  modelPath?: string;
}

/**
 * The top of the person in a mask, in mask rows: the first row with a
 * meaningful run of them in it — a few stray pixels of hair are not the head.
 * Null when there is no one in the frame.
 */
export function topOfPerson(mask: Uint8Array, width: number, height: number): number | null {
  const needed = Math.max(2, Math.round(width * 0.03));
  for (let y = 0; y < height; y++) {
    let count = 0;
    for (let x = 0; x < width; x++) if (mask[y * width + x] > 127) count++;
    if (count >= needed) return y;
  }
  return null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export interface PersonMaskResult {
  frames: number;
  masked: number;
  /** For each window, where the top of the person is in the frame (frame pixels), or null: nobody there. */
  tops: Array<number | null>;
}

export async function writePersonMask(options: PersonMaskOptions): Promise<PersonMaskResult> {
  const { inputPath, outputPath, frame, fps, windows, modelPath = PERSON_MODEL_PATH } = options;
  // Required here, not imported at the top: the API process never makes a
  // mask and should not load a native runtime it does not use. The package
  // ships without its own typings; onnxruntime-common is where they live.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ort = require('onnxruntime-node') as typeof import('onnxruntime-common');
  const session = await ort.InferenceSession.create(modelPath, { intraOpNumThreads: 2 });
  const { width: w, height: h } = maskInputSize(frame);
  const pixels = w * h;

  const decoder = spawnFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-i', inputPath,
    '-vf', `scale=${w}:${h}`,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
  ]);
  const encoder = spawnFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${w}x${h}`, '-r', String(fps), '-i', 'pipe:0',
    // Lossless: the mask is the edge of the speaker, and compression
    // artefacts on it would show as a crawling outline.
    '-c:v', 'ffv1', outputPath,
  ]);
  // A dead encoder surfaces through its exit code below, not as an
  // unhandled EPIPE on the pipe we were writing to.
  encoder.stdin.on('error', () => {});
  const decoded = finished(decoder, 'mask decoder');
  const encoded = finished(encoder, 'mask encoder');

  const empty = Buffer.alloc(pixels);
  const input = new Float32Array(3 * pixels);
  let frames = 0;
  let masked = 0;
  const topsByWindow: number[][] = windows.map(() => []);
  let pending: Buffer = Buffer.alloc(0);
  const frameBytes = pixels * 3;

  try {
    for await (const chunk of decoder.stdout) {
      pending = pending.length ? Buffer.concat([pending, chunk as Buffer]) : (chunk as Buffer);
      while (pending.length >= frameBytes) {
        const rgb = pending.subarray(0, frameBytes);
        pending = pending.subarray(frameBytes);
        let mask = empty;
        if (frameNeedsMask(frames, fps, windows)) {
          // MODNet's preprocessing: planar RGB, scaled to [-1, 1].
          for (let i = 0; i < pixels; i++) {
            input[i] = rgb[i * 3] / 127.5 - 1;
            input[pixels + i] = rgb[i * 3 + 1] / 127.5 - 1;
            input[2 * pixels + i] = rgb[i * 3 + 2] / 127.5 - 1;
          }
          const result = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, h, w]) });
          const matte = result[session.outputNames[0]].data as Float32Array;
          mask = Buffer.alloc(pixels);
          for (let i = 0; i < pixels; i++) mask[i] = Math.max(0, Math.min(255, Math.round(matte[i] * 255)));
          masked++;
          const top = topOfPerson(mask, w, h);
          const t = frames / fps;
          const k = windows.findIndex((win) => t >= win.start && t < win.end);
          if (top !== null && k >= 0) topsByWindow[k].push(top);
        }
        frames++;
        if (!encoder.stdin.write(mask)) await new Promise((resolve) => encoder.stdin.once('drain', resolve));
      }
    }
  } finally {
    encoder.stdin.end();
  }
  await Promise.all([decoded, encoded]);
  // The median over the window: a nod or a hand in the hair should not move
  // the word, and the word does not move while it is up anyway.
  const tops = topsByWindow.map((list) => {
    const m = median(list);
    return m === null ? null : Math.round((m * frame.height) / h);
  });
  return { frames, masked, tops };
}

function spawnFfmpeg(args: string[]): ChildProcessWithoutNullStreams {
  return spawn(FFMPEG, args, { stdio: ['pipe', 'pipe', 'pipe'] });
}

function finished(child: ChildProcessWithoutNullStreams, name: string): Promise<void> {
  let stderr = '';
  child.stderr.on('data', (b: Buffer) => {
    stderr = (stderr + b.toString()).slice(-2000);
  });
  return new Promise((resolve, reject) => {
    child.on('error', (err) => reject(new Error(`${name} could not be started: ${err.message}`)));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${name} exited with code ${code}: ${stderr}`))));
  });
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { denoiseModelAvailable, extractAudio, ffmpegAvailable, probe, renderSegments, RNNOISE_MODEL_PATH } from './ffmpeg';
import { DEFAULT_SMART_CUT_OPTIONS, planSmartCut, type TranscriptWord } from './smartCut';
import { DEFAULT_SUBTITLE_STYLE, buildSubtitlesForPlan } from './subtitles';
import { transcribeWithWhisper } from './transcription';

// Runs the Level-3 pipeline against a local file — no database, no object
// storage, no worker. Its purpose is tuning: the thresholds in
// DEFAULT_SMART_CUT_OPTIONS were chosen by reasoning, not by measurement, and
// the only way to find the right ones is to watch real footage come out the
// other side and change a number.
//
//   npm run smartcut -- ./video.mp4
//   npm run smartcut -- ./video.mp4 --max-pause 0.5 --no-subs
//
// The transcript is cached next to the input on the first run and reused
// after, so re-running with different thresholds costs nothing — which is the
// whole point, since that is the loop you actually iterate in.

interface CliOptions {
  input: string;
  output: string;
  subtitles: boolean;
  maxPauseSec: number;
  paddingSec: number;
  fillerWords: string[] | null;
  reuseTranscript: boolean;
  keepWork: boolean;
  denoise: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const positional = argv.filter((a) => !a.startsWith('--'));
  if (positional.length === 0) {
    throw new Error('usage: npm run smartcut -- <video> [--out result.mp4] [--max-pause 0.7] [--padding 0.12] [--no-subs] [--no-fillers] [--denoise] [--fresh] [--keep-work]');
  }

  const flag = (name: string): boolean => argv.includes(`--${name}`);
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? undefined : argv[index + 1];
  };

  const input = path.resolve(positional[0]);
  const parsed = path.parse(input);

  return {
    input,
    output: path.resolve(value('out') ?? path.join(parsed.dir, `${parsed.name}.smartcut.mp4`)),
    subtitles: !flag('no-subs'),
    maxPauseSec: Number(value('max-pause') ?? DEFAULT_SMART_CUT_OPTIONS.maxPauseSec),
    paddingSec: Number(value('padding') ?? DEFAULT_SMART_CUT_OPTIONS.paddingSec),
    // --no-fillers isolates the pause cutting from the word dropping, which is
    // the first thing you want when a result sounds wrong and you need to know
    // which of the two did it.
    fillerWords: flag('no-fillers') ? [] : null,
    reuseTranscript: !flag('fresh'),
    keepWork: flag('keep-work'),
    // Same switch the UI offers, here too: the thresholds this CLI exists to
    // tune are judged by ear, and judging them on audio the product will
    // denoise but the CLI will not is judging the wrong thing.
    denoise: flag('denoise'),
  };
}

function seconds(value: number): string {
  const m = Math.floor(value / 60);
  const s = value - m * 60;
  return m > 0 ? `${m}m ${s.toFixed(1)}s` : `${s.toFixed(1)}s`;
}

async function loadTranscript(options: CliOptions, audioPath: string, cachePath: string): Promise<TranscriptWord[]> {
  if (options.reuseTranscript) {
    try {
      const cached = JSON.parse(await fs.readFile(cachePath, 'utf-8')) as { words: TranscriptWord[] };
      console.log(`  транскрипт из кэша (${cached.words.length} слов) — ${path.basename(cachePath)}`);
      console.log('  пересчитать заново: --fresh');
      return cached.words;
    } catch {
      // No cache yet, or it is unreadable — fall through and transcribe.
    }
  }

  if (!process.env.OPENAI_API_KEY) {
    throw new Error('нужен OPENAI_API_KEY (в .env или в окружении) — транскрипт берётся из Whisper API');
  }

  const started = Date.now();
  const result = await transcribeWithWhisper(audioPath);
  console.log(`  Whisper: ${result.words.length} слов, язык ${result.language ?? '?'}, ${((Date.now() - started) / 1000).toFixed(1)}s`);
  await fs.writeFile(cachePath, JSON.stringify({ words: result.words, language: result.language, text: result.text }, null, 2));
  return result.words;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (!(await ffmpegAvailable())) throw new Error('ffmpeg/ffprobe не найдены в PATH (brew install ffmpeg)');
  try {
    await fs.access(options.input);
  } catch {
    throw new Error(`файл не найден: ${options.input}`);
  }

  const workDir = path.join(path.dirname(options.output), `.smartcut-${path.parse(options.input).name}`);
  await fs.mkdir(workDir, { recursive: true });

  console.log(`\n▸ Исходник: ${options.input}`);
  const info = await probe(options.input);
  console.log(`  ${info.width}x${info.height}, ${seconds(info.durationSec)}, аудио: ${info.hasAudio ? 'есть' : 'НЕТ'}`);
  if (!info.hasAudio) throw new Error('в файле нет аудиодорожки — резать не по чему');

  console.log('\n▸ Расшифровка');
  const audioPath = path.join(workDir, 'audio.mp3');
  await extractAudio(options.input, audioPath);
  const words = await loadTranscript(options, audioPath, path.join(workDir, 'transcript.json'));

  console.log('\n▸ План нарезки');
  const plan = planSmartCut(words, info.durationSec, {
    ...DEFAULT_SMART_CUT_OPTIONS,
    maxPauseSec: options.maxPauseSec,
    paddingSec: options.paddingSec,
    ...(options.fillerWords ? { fillerWords: options.fillerWords } : {}),
  });
  const removedPercent = info.durationSec > 0 ? (plan.removedDurationSec / info.durationSec) * 100 : 0;
  console.log(`  порог паузы ${options.maxPauseSec}s, падинг ${options.paddingSec}s`);
  console.log(`  ${seconds(plan.sourceDurationSec)} → ${seconds(plan.keptDurationSec)}  (вырезано ${removedPercent.toFixed(0)}%)`);
  console.log(`  склеек: ${Math.max(0, plan.segments.length - 1)}, филлеров убрано: ${plan.droppedFillerCount}`);
  if (plan.degraded) console.log('  ВНИМАНИЕ: сработал лимит склеек, вырезаны только самые длинные паузы');
  printLongestCuts(plan.segments, info.durationSec);

  let subtitlePath: string | undefined;
  if (options.subtitles) {
    console.log('\n▸ Субтитры');
    const { ass, chunks } = buildSubtitlesForPlan(words, plan.segments);
    if (chunks.length === 0) {
      console.log('  титров нет (пустой транскрипт) — рендер без них');
    } else {
      subtitlePath = path.join(workDir, 'captions.ass');
      await fs.writeFile(subtitlePath, ass, 'utf-8');
      console.log(`  блоков: ${chunks.length}, шрифт ${DEFAULT_SUBTITLE_STYLE.fontName}`);
      console.log(`  первые: ${chunks.slice(0, 3).map((c) => `«${c.words.map((w) => w.word).join(' ')}»`).join(', ')}`);
      console.log(`  файл: ${subtitlePath}`);
    }
  }

  let denoiseModelPath: string | undefined;
  if (options.denoise) {
    if (await denoiseModelAvailable()) {
      denoiseModelPath = RNNOISE_MODEL_PATH;
      console.log(`\n▸ Шумодав: RNNoise (${path.basename(RNNOISE_MODEL_PATH)})`);
    } else {
      console.log(`\n▸ Шумодав: пропущен — нет модели ${RNNOISE_MODEL_PATH}`);
    }
  }

  console.log('\n▸ Рендер');
  const started = Date.now();
  let lastLogged = -1;
  await renderSegments({
    inputPath: options.input,
    outputPath: options.output,
    workDir,
    segments: plan.segments,
    expectedDurationSec: plan.keptDurationSec,
    subtitlePath,
    denoiseModelPath,
    onProgress: (fraction) => {
      const percent = Math.floor(fraction * 10) * 10;
      if (percent > lastLogged) { lastLogged = percent; process.stdout.write(`  ${percent}%\r`); }
    },
  });

  const elapsedSec = (Date.now() - started) / 1000;
  const result = await probe(options.output);
  // The number that decides whether this is viable on a small cloud instance:
  // below 1.0 the render is slower than the video it produces.
  const speed = plan.keptDurationSec / elapsedSec;
  console.log(`  готово за ${seconds(elapsedSec)} (${speed.toFixed(2)}x реального времени)`);
  console.log(`\n▸ Результат: ${options.output}`);
  console.log(`  ${result.width}x${result.height}, ${seconds(result.durationSec)}\n`);

  if (!options.keepWork) await fs.rm(workDir, { recursive: true, force: true });
  else console.log(`  промежуточные файлы: ${workDir}\n`);
}

// The cuts are what you actually judge the thresholds by — a list of "3.4s
// removed at 01:12" tells you immediately whether it ate a dramatic pause.
function printLongestCuts(segments: Array<{ start: number; end: number }>, durationSec: number): void {
  const cuts: Array<{ at: number; length: number }> = [];
  let cursor = 0;
  for (const segment of segments) {
    if (segment.start > cursor) cuts.push({ at: cursor, length: segment.start - cursor });
    cursor = segment.end;
  }
  if (durationSec > cursor) cuts.push({ at: cursor, length: durationSec - cursor });

  const longest = cuts.sort((a, b) => b.length - a.length).slice(0, 5);
  if (longest.length === 0) return;
  console.log('  самые длинные вырезы:');
  for (const cut of longest) {
    const m = Math.floor(cut.at / 60);
    const s = Math.floor(cut.at % 60);
    console.log(`    ${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}  −${cut.length.toFixed(1)}s`);
  }
}

main().catch((err) => {
  console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

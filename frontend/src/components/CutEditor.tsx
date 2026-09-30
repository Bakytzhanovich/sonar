'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  type ApiConfig,
  type AspectRatioOption,
  type CutEditorData,
  type CutStyle,
  type HeadlineOption,
  type PosterLayout,
  type SubtitlePosition,
  type SubtitlePreset,
} from '@/lib/api';
import PillPicker from './PillPicker';
import CaptionOverlay, { type CaptionLook } from './CaptionOverlay';
// The renderer's own chunking and emphasis, imported rather than reimplemented.
// Both are pure — no filesystem, no node builtins — so the browser can run the
// exact code that decides where caption lines break and which word is shouted.
// A second copy here would be a third thing to keep in step with the ASS
// generator and the overlay's CSS.
import { chunkWords, DEFAULT_CHUNK_OPTIONS, joinBoundaries, remapWordsToOutputTimeline } from '@shared/subtitles';
import { pickEmphasis } from '@shared/emphasis';
import styles from './CutEditor.module.css';

// Module 8, level 3 — the manual half of Smart Cut.
//
// The automatic cut is a guess made from a transcript, and a guess is
// sometimes wrong in ways only the person who filmed it can see: a pause that
// was deliberate, a sentence worth keeping, a false start the planner left in.
// This is where they say so. Nothing here re-renders anything — it produces a
// list of keep-segments and hands it to the API, which starts a fresh job.
//
// The timeline is drawn against the SOURCE, not the finished render. That is
// the whole point: the parts the planner threw away have to be visible and
// reachable, because those are exactly the ones someone reaches for when it
// cut something it should not have.

interface Segment {
  start: number;
  end: number;
}

// Below this a segment is a frame or two of noise — long enough to survive a
// clumsy drag, short enough not to stop a deliberately quick cut.
const MIN_SEGMENT_SEC = 0.2;

function formatTime(sec: number): string {
  const whole = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
}

function totalKept(segments: Segment[]): number {
  return segments.reduce((sum, s) => sum + (s.end - s.start), 0);
}

// The holes between kept segments — what the cut currently throws away, and
// what a person clicks to get back.
function gapsBetween(segments: Segment[], duration: number): Segment[] {
  const gaps: Segment[] = [];
  let cursor = 0;
  for (const segment of segments) {
    if (segment.start - cursor > 0.01) gaps.push({ start: cursor, end: segment.start });
    cursor = segment.end;
  }
  if (duration - cursor > 0.01) gaps.push({ start: cursor, end: duration });
  return gaps;
}

// Restoring a gap always touches its neighbours, so the result is one
// continuous block rather than three abutting ones. Merging here keeps what
// is drawn identical to what the server will store — it normalises the same
// way — so the timeline never shows a seam the render will not have.
function mergeTouching(segments: Segment[]): Segment[] {
  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const merged: Segment[] = [];
  for (const segment of sorted) {
    const last = merged[merged.length - 1];
    if (last && segment.start <= last.end + 0.01) last.end = Math.max(last.end, segment.end);
    else merged.push({ ...segment });
  }
  return merged;
}

export default function CutEditor({
  config,
  jobId,
  onClose,
  onRevised,
}: {
  config: ApiConfig;
  jobId: string;
  onClose: () => void;
  onRevised: (newJobId: string) => void;
}) {
  const [data, setData] = useState<CutEditorData | null>(null);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  // Playing the source straight through would show a video nobody asked for:
  // the person just watched the edit and pressed "edit it", so the edit is
  // what play should give them. Preview skips the cut parts as it plays, the
  // way a timeline preview does — the removed footage stays on the timeline
  // and reachable, it just does not interrupt the watch. Turned off when
  // someone is hunting through what was thrown away for something to restore.
  // Three things worth watching, and they are not interchangeable:
  //   result  — the finished render being edited, captions and headline
  //             burned in. What the person was just looking at, and the only
  //             place the caption style is actually visible.
  //   preview — the source with the cut parts skipped, which is the edit as
  //             it stands right now, including changes not rendered yet.
  //   source  — the whole source, for hunting through what was thrown away.
  const [mode, setMode] = useState<'result' | 'preview' | 'source'>('result');
  const preview = mode === 'preview';
  // The result is a different timeline — twenty seconds against the source's
  // forty-six — so the strip below must not follow it, and a seek asked for
  // while it is on screen has to land on the source instead. Held until the
  // swapped-in element reports it is ready, because setting currentTime on
  // one that is still loading is silently dropped.
  const pendingSeek = useRef<number | null>(null);
  // The look, and the words themselves. Both start as whatever produced the
  // render being edited, so opening the editor and pressing "Пересобрать"
  // without touching anything reproduces what is already there.
  const [style, setStyle] = useState<CutStyle | null>(null);
  const [words, setWords] = useState<string[]>([]);
  const [editingWord, setEditingWord] = useState<number | null>(null);
  // The rendered sample of this very video with the look currently chosen.
  // Asked for by a button rather than on every pill tap: each one is a job
  // for the worker, and someone comparing seven colours would queue seven
  // renders without meaning to.
  const [sample, setSample] = useState<{ state: 'rendering' | 'ready' | 'failed'; url?: string; reason?: string } | null>(null);
  const [catalogue, setCatalogue] = useState<{
    presets: SubtitlePreset[];
    positions: SubtitlePosition[];
    aspectRatios: AspectRatioOption[];
    headlineFonts: HeadlineOption[];
    headlineSizes: HeadlineOption[];
    headlineColors: Array<HeadlineOption & { hex: string }>;
    headlineMaxChars: number;
    subtitleFonts: Array<HeadlineOption & { family: string }>;
    subtitleColors: Array<HeadlineOption & { hex: string }>;
    subtitleSizes: HeadlineOption[];
    posterLayout: PosterLayout | null;
    sizeScales: Record<string, number>;
    fontEmRatios: Record<string, number>;
  } | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  // Held in a ref rather than state: a pointer drag fires dozens of moves a
  // second, and routing each through a re-render makes the handle lag behind
  // the cursor.
  const dragRef = useRef<{ index: number; edge: 'start' | 'end' } | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getCutEditor(config, jobId)
      .then((loaded) => {
        if (cancelled) return;
        setData(loaded);
        setSegments(loaded.segments);
        setStyle(loaded.style);
        setWords(loaded.words.map((w) => w.word));
        // Opening on the finished render is the point — it is what the person
        // was looking at when they decided to change something. A job that
        // never produced one opens on the edit instead; leaving the mode at
        // 'result' there would show the source while refusing to track it.
        if (!loaded.result_url) setMode('preview');
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Не удалось открыть редактор');
      });
    return () => {
      cancelled = true;
    };
  }, [config, jobId]);

  // The catalogues come from the server rather than a copy kept here: these
  // styles are defined in the renderer's terms, and two lists drift.
  useEffect(() => {
    let cancelled = false;
    api
      .listSubtitlePresets(config)
      .then((res) => {
        if (cancelled) return;
        setCatalogue({
          presets: res.presets ?? [],
          positions: res.positions ?? [],
          aspectRatios: res.aspectRatios ?? [],
          headlineFonts: res.headlineFonts ?? [],
          headlineSizes: res.headlineSizes ?? [],
          headlineColors: res.headlineColors ?? [],
          headlineMaxChars: res.headlineMaxChars ?? 48,
          subtitleFonts: res.subtitleFonts ?? [],
          subtitleColors: res.subtitleColors ?? [],
          subtitleSizes: res.subtitleSizes ?? [],
          posterLayout: res.posterLayout ?? null,
          sizeScales: res.sizeScales ?? {},
          fontEmRatios: res.fontEmRatios ?? {},
        });
      })
      // A picker that cannot be drawn is not worth failing the editor over:
      // the cut is still editable, and the look simply stays as it was.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [config]);

  const duration = data?.duration_sec ?? 0;

  const timeAt = useCallback(
    (clientX: number): number => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return 0;
      return Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1) * duration;
    },
    [duration]
  );

  // Dragging is bound to the window, not to the handle: a pointer that
  // outruns the element mid-drag would otherwise drop the gesture and leave
  // the edge wherever the cursor happened to lose it.
  useEffect(() => {
    function onMove(event: PointerEvent) {
      const drag = dragRef.current;
      if (!drag) return;
      event.preventDefault();
      setSegments((current) => {
        const next = current.map((s) => ({ ...s }));
        const segment = next[drag.index];
        if (!segment) return current;
        const t = timeAt(event.clientX);
        if (drag.edge === 'start') {
          // An edge may meet its neighbour but never pass through it —
          // crossing would invert the segment or swallow the one next door,
          // and both read as the timeline glitching rather than as an edit.
          const floor = drag.index > 0 ? next[drag.index - 1].end : 0;
          segment.start = Math.min(Math.max(t, floor), segment.end - MIN_SEGMENT_SEC);
        } else {
          const ceiling = drag.index < next.length - 1 ? next[drag.index + 1].start : duration;
          segment.end = Math.max(Math.min(t, ceiling), segment.start + MIN_SEGMENT_SEC);
        }
        return next;
      });
    }
    function onUp() {
      dragRef.current = null;
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [duration, timeAt]);

  // `to` is always a source timestamp — the strip, the segments and the words
  // are all measured there. Asking for one while the finished render is on
  // screen therefore means leaving it: that file has no such moment.
  function seek(to: number, into: 'preview' | 'source' = 'preview') {
    const at = Math.min(Math.max(to, 0), duration);
    setPlayhead(at);
    if (mode === 'result') {
      pendingSeek.current = at;
      setMode(into);
      return;
    }
    if (into === 'source') setMode('source');
    const video = videoRef.current;
    if (video) video.currentTime = at;
  }

  function restoreGap(gap: Segment) {
    setSegments((current) => mergeTouching([...current, gap]));
    setSelected(null);
  }

  function dropSegment(index: number) {
    setSegments((current) => {
      // One segment has to survive: zero of them is not a shorter video, it
      // is no video, and the server refuses it anyway.
      if (current.length <= 1) return current;
      return current.filter((_, i) => i !== index);
    });
    setSelected(null);
  }

  // Renders four seconds of this video with the look on screen. Polled
  // rather than awaited: it is a worker job, and the API answers as soon as
  // the row exists, not when ffmpeg is done.
  async function renderSample() {
    setSample({ state: 'rendering' });
    try {
      const { job } = await api.previewCut(config, jobId, segments, {
        ...(style ?? {}),
      });

      // Roughly a minute of patience. A four-second render is seconds of
      // ffmpeg; past this the worker is not running, and saying so beats a
      // spinner that never stops.
      for (let i = 0; i < 30; i++) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const latest = await api.getVideoJob(config, job.id);
        if (latest.job.status === 'completed' && latest.job.output_url) {
          setSample({ state: 'ready', url: latest.job.output_url });
          return;
        }
        if (latest.job.status === 'failed') {
          setSample({ state: 'failed', reason: latest.job.failure_reason ?? undefined });
          return;
        }
      }
      setSample({ state: 'failed', reason: 'обработчик не ответил' });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setSample({
        state: 'failed',
        // The one refusal worth explaining rather than reporting: it is not a
        // fault, it is that this cut kept no speech to put captions on.
        reason: message.includes('no_speech_to_preview')
          ? 'в этой нарезке нет речи — показывать субтитры не на чем'
          : message,
      });
    }
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const { job } = await api.reviseCut(config, jobId, segments, {
        ...(style ?? {}),
        // Only when something was actually retyped: an unchanged list is the
        // transcript the parent already holds, and sending it back would be
        // a no-op that can only go wrong.
        ...(wordsChanged ? { words } : {}),
      });
      onRevised(job.id);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Не удалось пересобрать');
      setSaving(false);
    }
  }

  const gaps = useMemo(() => gapsBetween(segments, duration), [segments, duration]);
  const kept = totalKept(segments);
  // Left unmemoised on purpose: both are a walk over a few hundred short
  // strings, and hand-memoising them defeats the React Compiler, which
  // refuses to optimise a component whose manual memoization it cannot
  // preserve — costing far more than these comparisons ever would.
  const wordsChanged = words.some((w, i) => w !== data?.words[i]?.word);
  // Enables the button. Any of the three counts: someone may open this only
  // to fix one misheard name and leave the cut exactly as the AI made it.
  const changed =
    JSON.stringify(segments) !== JSON.stringify(data?.segments ?? []) ||
    JSON.stringify(style) !== JSON.stringify(data?.style ?? null) ||
    wordsChanged;

  // A word belongs to the cut when its middle falls inside a kept segment.
  // Measured at the midpoint rather than the start so a word straddling a
  // boundary lands on the side it mostly plays on.
  const wordKept = useCallback(
    (word: { start: number; end: number }) => {
      const middle = (word.start + word.end) / 2;
      return segments.some((s) => middle >= s.start && middle <= s.end);
    },
    [segments]
  );

  // ---- Live captions -----------------------------------------------------
  //
  // Unlike the creation screen, which can only show sample words, this has the
  // real transcript — so the overlay shows the person's own captions at their
  // own moments, and re-cuts itself as boundaries are dragged.

  // The transcript as it stands, corrections included: timings from the
  // server, text from whatever has been retyped.
  const editedWords = (data?.words ?? []).map((word, i) => ({ ...word, word: words[i] ?? word.word }));

  // Where the playhead is on the OUTPUT timeline. The strip and the player
  // both speak source time, but captions live in output time — the difference
  // is exactly the footage the cut removes before this moment.
  function toOutputTime(sourceTime: number): number {
    let elapsed = 0;
    for (const segment of segments) {
      if (sourceTime < segment.start) break;
      if (sourceTime <= segment.end) return elapsed + (sourceTime - segment.start);
      elapsed += segment.end - segment.start;
    }
    return elapsed;
  }

  // The renderer's own chunking, against the cut currently drawn.
  const chunks =
    editedWords.length > 0
      ? chunkWords(
          remapWordsToOutputTimeline(editedWords, segments),
          DEFAULT_CHUNK_OPTIONS,
          joinBoundaries(segments)
        )
      : [];

  const outputNow = toOutputTime(playhead);
  const activeChunk = chunks.find((c) => outputNow >= c.start && outputNow <= c.end);
  const presetLayout = catalogue?.presets.find((p) => p.id === style?.subtitlePreset)?.layout;
  const captionLook: CaptionLook | null =
    style && presetLayout && catalogue?.posterLayout
      ? {
          preset: presetLayout,
          poster: catalogue.posterLayout,
          sizeScale: catalogue.sizeScales[style.subtitleSize] ?? 1,
          fontFamily: catalogue.subtitleFonts.find((f) => f.id === style.subtitleFont)?.family || undefined,
          emRatio:
            catalogue.fontEmRatios[
              catalogue.subtitleFonts.find((f) => f.id === style.subtitleFont)?.family || presetLayout.fontFamily
            ],
          highlight: catalogue.subtitleColors.find((c) => c.id === style.subtitleColor)?.hex,
          position: style.subtitlePosition as 'auto' | 'top' | 'middle' | 'bottom',
        }
      : null;

  const pct = (value: number) => (duration > 0 ? (value / duration) * 100 : 0);

  return (
    <div className={styles.backdrop} role="dialog" aria-modal="true" aria-label="Редактор нарезки">
      <div className={styles.panel}>
        <header className={styles.header}>
          <h2>Редактор нарезки</h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Закрыть">
            ✕
          </button>
        </header>

        {error && <p className={styles.error}>{error}</p>}
        {!data && !error && <p className={styles.loading}>Загружаю исходник…</p>}

        {data && (
          <>
            <div className={styles.playerStage}>
            <video
              // Remounted when swapping between the render and the source:
              // they are different files of different lengths, and reusing
              // one element leaves the old duration and position behind.
              key={mode === 'result' ? 'result' : 'source'}
              ref={videoRef}
              className={styles.player}
              src={mode === 'result' && data.result_url ? data.result_url : data.source_url}
              controls
              preload="metadata"
              onLoadedMetadata={(e) => {
                const at = pendingSeek.current;
                if (at === null) return;
                pendingSeek.current = null;
                e.currentTarget.currentTime = at;
              }}
              onTimeUpdate={(e) => {
                const video = e.currentTarget;
                // The finished render runs on its own timeline; letting it
                // drive the strip would slide the playhead to a moment of the
                // source that has nothing to do with what is on screen.
                if (mode === 'result') return;
                setPlayhead(video.currentTime);
                if (!preview || segments.length === 0) return;
                // Inside a cut? Jump to where the edit resumes. Compared
                // against the segment a hair BEFORE the playhead so a jump
                // that lands exactly on a boundary is not read as still
                // being in the hole it just left, which would re-fire this
                // every frame and freeze playback.
                const inKept = segments.some(
                  (s) => video.currentTime >= s.start - 0.05 && video.currentTime <= s.end
                );
                if (inKept) return;
                const next = segments.find((s) => s.start > video.currentTime);
                // Nothing after this hole means the edit is over, even though
                // the source runs on. Stopping is what the finished render
                // does, so it is what the preview should do.
                if (next) video.currentTime = next.start;
                else video.pause();
              }}
            />
            {/* Only over the source views. The finished render already has
                its captions burned in, and drawing a second set on top of
                them would be two copies of the same words at slightly
                different sizes. */}
            {mode !== 'result' && style?.subtitles && captionLook && activeChunk && (
              <CaptionOverlay
                line={{
                  words: activeChunk.words.map((w) => w.word),
                  emphasis: pickEmphasis(activeChunk.words.map((w) => w.word)),
                }}
                look={captionLook}
              />
            )}
            </div>

            <div className={styles.modeRow}>
              {/* Only offered when there is one — a job that failed before it
                  rendered has no result to show. */}
              {data.result_url && (
                <button
                  type="button"
                  className={`${styles.mode} ${mode === 'result' ? styles.modeOn : ''}`}
                  onClick={() => setMode('result')}
                >
                  Готовый вариант
                </button>
              )}
              <button
                type="button"
                className={`${styles.mode} ${mode === 'preview' ? styles.modeOn : ''}`}
                onClick={() => setMode('preview')}
              >
                Мой монтаж
              </button>
              <button
                type="button"
                className={`${styles.mode} ${mode === 'source' ? styles.modeOn : ''}`}
                onClick={() => setMode('source')}
              >
                Исходник
              </button>
            </div>

            <p className={styles.lead}>
              {mode === 'result' &&
                'Это то, что ИИ смонтировал: с субтитрами и заголовком. Правки ниже в нём ещё не видны — переключись на «Мой монтаж», чтобы посмотреть новую нарезку.'}
              {mode === 'preview' &&
                'Нарезка с твоими правками — вырезанное пропускается. Субтитров и заголовка здесь нет: они появятся только после пересборки.'}
              {mode === 'source' && 'Исходник целиком, вместе с вырезанным.'}{' '}
              Цветом на полосе отмечено то, что останется. Потяни края, чтобы подвинуть границу;
              нажми на вырезанный кусок, чтобы вернуть его.
            </p>

            <div
              ref={trackRef}
              className={styles.track}
              onPointerDown={(e) => {
                // Only a click on the bare track seeks. Handles and blocks
                // stop the event themselves, so this cannot fire mid-drag.
                if (e.target === trackRef.current) seek(timeAt(e.clientX));
              }}
            >
              {gaps.map((gap) => (
                <button
                  type="button"
                  key={`gap-${gap.start}`}
                  className={styles.gap}
                  style={{ left: `${pct(gap.start)}%`, width: `${pct(gap.end - gap.start)}%` }}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => restoreGap(gap)}
                  title={`Вернуть ${(gap.end - gap.start).toFixed(1)}с`}
                />
              ))}

              {segments.map((segment, index) => (
                <div
                  key={`seg-${index}`}
                  className={`${styles.segment} ${selected === index ? styles.segmentSelected : ''}`}
                  style={{ left: `${pct(segment.start)}%`, width: `${pct(segment.end - segment.start)}%` }}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    setSelected(index);
                    seek(segment.start);
                  }}
                >
                  <span
                    className={`${styles.handle} ${styles.handleStart}`}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      dragRef.current = { index, edge: 'start' };
                    }}
                  />
                  <span
                    className={`${styles.handle} ${styles.handleEnd}`}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      dragRef.current = { index, edge: 'end' };
                    }}
                  />
                </div>
              ))}

              <span className={styles.playhead} style={{ left: `${pct(playhead)}%` }} />
            </div>

            <div className={styles.trackMeta}>
              <span>{formatTime(playhead)}</span>
              <span>{formatTime(duration)}</span>
            </div>

            {selected !== null && segments[selected] && (
              <div className={styles.selectionRow}>
                <span>
                  Кусок {formatTime(segments[selected].start)} — {formatTime(segments[selected].end)}
                </span>
                <button
                  type="button"
                  className={styles.dropButton}
                  disabled={segments.length <= 1}
                  onClick={() => dropSegment(selected)}
                >
                  Убрать
                </button>
              </div>
            )}

            {/* Reading is faster than scrubbing for finding where a sentence
                ends, and the transcript is already in hand — it is what the
                cut was planned from. Struck-through words are the ones the
                current cut drops. */}
            {data.words.length > 0 && (
              <>
                <p className={styles.sectionLabel}>
                  Текст субтитров — нажми на слово, чтобы перемотать, дважды — чтобы исправить
                </p>
                <div className={styles.words}>
                  {data.words.map((word, i) =>
                    editingWord === i ? (
                      <input
                        key={`edit-${i}`}
                        className={styles.wordInput}
                        value={words[i] ?? ''}
                        autoFocus
                        size={Math.max(4, (words[i] ?? '').length)}
                        onChange={(e) =>
                          setWords((current) => current.map((w, j) => (j === i ? e.target.value : w)))
                        }
                        onBlur={() => setEditingWord(null)}
                        onKeyDown={(e) => {
                          // Enter commits, Escape puts the original back —
                          // the two things a text field is expected to do.
                          if (e.key === 'Enter') setEditingWord(null);
                          if (e.key === 'Escape') {
                            setWords((current) =>
                              current.map((w, j) => (j === i ? data.words[i].word : w))
                            );
                            setEditingWord(null);
                          }
                        }}
                      />
                    ) : (
                      <button
                        type="button"
                        key={`${word.start}-${i}`}
                        className={`${styles.word} ${wordKept(word) ? '' : styles.wordCut} ${
                          words[i] !== word.word ? styles.wordFixed : ''
                        }`}
                        onClick={() => {
                          // Asking to hear a word the cut drops is asking to
                          // hear the source. Left in preview the playhead
                          // would land there and be thrown straight out
                          // again, which reads as the click doing nothing.
                          seek(word.start, wordKept(word) ? 'preview' : 'source');
                        }}
                        onDoubleClick={() => setEditingWord(i)}
                      >
                        {words[i] ?? word.word}
                      </button>
                    )
                  )}
                </div>
              </>
            )}

            {style && catalogue && (
              <div className={styles.styleGrid}>
                {/* Rows rather than dropdowns: these are chosen by comparing,
                    and a menu shows one option at a time. Most obvious on the
                    colours, where a list of words becomes a palette the
                    moment each carries its own dot. */}
                <div className={styles.pickers}>
                  <PillPicker
                    label="Стиль субтитров"
                    options={catalogue.presets}
                    value={style.subtitlePreset}
                    disabled={!style.subtitles}
                    onChange={(id) => setStyle({ ...style, subtitlePreset: id })}
                  />
                  <PillPicker
                    label="Шрифт"
                    options={catalogue.subtitleFonts}
                    value={style.subtitleFont}
                    disabled={!style.subtitles}
                    onChange={(id) => setStyle({ ...style, subtitleFont: id })}
                  />
                  <PillPicker
                    label="Цвет"
                    options={catalogue.subtitleColors}
                    value={style.subtitleColor}
                    disabled={!style.subtitles}
                    onChange={(id) => setStyle({ ...style, subtitleColor: id })}
                  />
                  <PillPicker
                    label="Размер"
                    options={catalogue.subtitleSizes}
                    value={style.subtitleSize}
                    disabled={!style.subtitles}
                    onChange={(id) => setStyle({ ...style, subtitleSize: id })}
                  />
                  <PillPicker
                    label="Положение"
                    options={catalogue.positions}
                    value={style.subtitlePosition}
                    disabled={!style.subtitles}
                    onChange={(id) => setStyle({ ...style, subtitlePosition: id })}
                  />
                  <PillPicker
                    label="Формат кадра"
                    options={catalogue.aspectRatios}
                    value={style.aspectRatio}
                    onChange={(id) => setStyle({ ...style, aspectRatio: id })}
                  />
                </div>

                <label className={`${styles.field} ${styles.fieldWide}`}>
                  <span>Заголовок — пусто означает без плашки</span>
                  <input
                    type="text"
                    value={style.headline ?? ''}
                    maxLength={catalogue.headlineMaxChars}
                    onChange={(e) => setStyle({ ...style, headline: e.target.value })}
                  />
                </label>

                {/* Only worth the room when there is a headline to style. */}
                {style.headline ? (
                  <div className={styles.pickers}>
                    <PillPicker
                      label="Шрифт заголовка"
                      options={catalogue.headlineFonts}
                      value={style.headlineFont}
                      onChange={(id) => setStyle({ ...style, headlineFont: id })}
                    />
                    <PillPicker
                      label="Размер заголовка"
                      options={catalogue.headlineSizes}
                      value={style.headlineSize}
                      onChange={(id) => setStyle({ ...style, headlineSize: id })}
                    />
                    <PillPicker
                      label="Цвет заголовка"
                      options={catalogue.headlineColors}
                      value={style.headlineColor}
                      onChange={(id) => setStyle({ ...style, headlineColor: id })}
                    />
                  </div>
                ) : null}

                {/* The only way to see a caption style before committing
                    to the whole video. Drawing them in the browser would mean
                    a second implementation of ASS in CSS, and two
                    implementations drift — a preview showing something the
                    renderer does not produce is worse than no preview. This
                    is the renderer itself, on four seconds. */}
                <div className={styles.sampleRow}>
                  <button
                    type="button"
                    className={styles.sampleButton}
                    onClick={renderSample}
                    disabled={sample?.state === 'rendering'}
                  >
                    {sample?.state === 'rendering' ? 'Собираю образец…' : 'Показать, как будет'}
                  </button>
                  <span className={styles.sampleHint}>
                    {sample?.state === 'rendering'
                      ? 'Несколько секунд — это настоящий рендер, а не рисунок'
                      : 'Четыре секунды этого видео с выбранным оформлением'}
                  </span>
                </div>

                {sample?.state === 'failed' && (
                  <p className={styles.sampleError}>Образец не собрался: {sample.reason ?? 'неизвестно'}</p>
                )}

                {sample?.state === 'ready' && sample.url && (
                  <div className={styles.sampleStage}>
                    <video className={styles.sampleVideo} src={sample.url} controls autoPlay loop playsInline />
                    <p className={styles.sampleNote}>
                      Так будут выглядеть субтитры. Нажми «Пересобрать», чтобы применить ко всему ролику.
                    </p>
                  </div>
                )}

                <label className={`${styles.field} ${styles.fieldCheck}`}>
                  <input
                    type="checkbox"
                    checked={style.subtitles}
                    onChange={(e) => setStyle({ ...style, subtitles: e.target.checked })}
                  />
                  <span>Вжигать субтитры в видео</span>
                </label>
              </div>
            )}

            <footer className={styles.footer}>
              <span className={styles.summary}>
                {duration.toFixed(1)}с → <strong>{kept.toFixed(1)}с</strong> · кусков {segments.length}
              </span>
              <div className={styles.actions}>
                <button type="button" className={styles.cancel} onClick={onClose}>
                  Отмена
                </button>
                <button
                  type="button"
                  className={styles.save}
                  onClick={save}
                  disabled={saving || !changed}
                >
                  {saving ? 'Отправляю…' : 'Пересобрать'}
                </button>
              </div>
            </footer>

            {/* Said before they press it, not after: someone who expects the
                old file to be replaced will otherwise go looking for it. */}
            <p className={styles.note}>
              Прошлый вариант останется в очереди — пересборка добавит новый, а не заменит его.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type ApiConfig, type CutEditorData } from '@/lib/api';
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
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Не удалось открыть редактор');
      });
    return () => {
      cancelled = true;
    };
  }, [config, jobId]);

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

  function seek(to: number) {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = Math.min(Math.max(to, 0), duration);
    setPlayhead(video.currentTime);
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

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const { job } = await api.reviseCut(config, jobId, segments);
      onRevised(job.id);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Не удалось пересобрать');
      setSaving(false);
    }
  }

  const gaps = useMemo(() => gapsBetween(segments, duration), [segments, duration]);
  const kept = totalKept(segments);
  const changed = useMemo(
    () => JSON.stringify(segments) !== JSON.stringify(data?.segments ?? []),
    [segments, data]
  );

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
            <video
              ref={videoRef}
              className={styles.player}
              src={data.source_url}
              controls
              preload="metadata"
              onTimeUpdate={(e) => setPlayhead(e.currentTarget.currentTime)}
            />

            <p className={styles.lead}>
              Синим — то, что останется. Потяни края, чтобы подвинуть границу; нажми на вырезанный
              кусок, чтобы вернуть его.
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
              <div className={styles.words}>
                {data.words.map((word, i) => (
                  <button
                    type="button"
                    key={`${word.start}-${i}`}
                    className={`${styles.word} ${wordKept(word) ? '' : styles.wordCut}`}
                    onClick={() => seek(word.start)}
                  >
                    {word.word}
                  </button>
                ))}
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

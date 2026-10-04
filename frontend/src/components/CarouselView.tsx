'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Canvas, Rect, StaticCanvas, Textbox, type StaticCanvas as StaticCanvasType } from 'fabric';
import { count } from '@/lib/plural';
import { api, type BrandPreset, type Carousel, type CarouselSlide } from '@/lib/api';
import { useDevConfig } from '@/lib/useDevConfig';
import { useApiAccess } from '@/lib/useApiAccess';
import PageHeader from './PageHeader';
import TabBar from './TabBar';
import PillPicker from './PillPicker';
import NoticeBanner, { MISSING_API_KEY_MESSAGE } from './NoticeBanner';
import StatusMessage from './StatusMessage';
import controls from './Controls.module.css';
import styles from './CarouselView.module.css';
import layout from './Layout.module.css';

// Module 4 — a carousel from one topic.
//
// The slide is drawn at 4:5, Instagram's carousel shape, and downloaded at
// 1080×1350 — the size Instagram shows it at. Text is edited in plain fields
// beside the slide and saved as you type: editing on the canvas itself meant
// knowing to double-click, then remembering a separate save button.

const CANVAS_W = 432;
const CANVAS_H = 540;
const EXPORT_MULTIPLIER = 1080 / CANVAS_W;
const SAVE_DELAY_MS = 700;

const EXAMPLES = ['5 ошибок новичков в спорте', 'Как выбрать курс и не пожалеть', '3 мифа о правильном питании'];

const GENERATE_ERRORS: Record<string, string> = {
  llm_not_configured: 'ИИ сейчас не подключён — карусель не создать',
  llm_invalid_answer: 'ИИ ответил что-то не то — нажмите «Сгенерировать» ещё раз',
  llm_failed: 'ИИ не ответил — попробуйте ещё раз через минуту',
};

function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const code = Object.keys(GENERATE_ERRORS).find((key) => message.includes(key));
  return code ? GENERATE_ERRORS[code] : message;
}

interface Look {
  background: string;
  text: string;
  font: string;
}

function lookOf(preset: BrandPreset | null): Look {
  return {
    background: preset?.secondary_color ?? '#ffffff',
    text: preset?.primary_color ?? '#111111',
    font: preset?.font_family && preset.font_family !== 'system-ui' ? preset.font_family : 'Geist, system-ui, sans-serif',
  };
}

/**
 * Draws one slide. The same function feeds the live preview and the
 * download, so what is downloaded is what was on screen.
 *
 * The first slide is the cover: a larger headline, lower on the slide.
 */
function drawSlide(canvas: StaticCanvasType, slide: Pick<CarouselSlide, 'headline' | 'body'>, index: number, total: number, look: Look) {
  canvas.clear();
  const pad = 36;
  const cover = index === 0;
  // Fabric 7 places objects by their centre unless told otherwise; every
  // coordinate below is a top-left corner. Without this the background
  // filled a quarter of the slide and the text hung off its left edge.
  const fixed = { selectable: false, evented: false, originX: 'left', originY: 'top' } as const;
  canvas.add(new Rect({ left: 0, top: 0, width: CANVAS_W, height: CANVAS_H, fill: look.background, ...fixed }));

  const headline = new Textbox(slide.headline, {
    left: pad,
    top: cover ? 150 : 64,
    width: CANVAS_W - pad * 2,
    fontSize: cover ? 40 : 30,
    fontWeight: 'bold',
    lineHeight: 1.12,
    fill: look.text,
    fontFamily: look.font,
    ...fixed,
  });
  canvas.add(headline);
  canvas.add(
    new Textbox(slide.body, {
      left: pad,
      top: headline.top + headline.height + 22,
      width: CANVAS_W - pad * 2,
      fontSize: cover ? 19 : 18,
      lineHeight: 1.35,
      fill: look.text,
      fontFamily: look.font,
      ...fixed,
    })
  );
  // Where this slide sits in the carousel — the swipe cue a reader expects.
  canvas.add(
    new Textbox(`${index + 1}/${total}`, {
      left: CANVAS_W - pad - 80,
      top: CANVAS_H - pad - 16,
      width: 80,
      textAlign: 'right',
      fontSize: 14,
      opacity: 0.55,
      fill: look.text,
      fontFamily: look.font,
      ...fixed,
    })
  );
  canvas.renderAll();
}

function download(dataUrl: string, name: string) {
  const link = document.createElement('a');
  link.href = dataUrl;
  link.download = name;
  link.click();
}

export default function CarouselView() {
  const [devConfig] = useDevConfig();
  const { baseUrl, apiKey } = devConfig;
  const config = { baseUrl, apiKey };
  // Not the same as holding a key — see useApiAccess: the session is a cookie
  // this code cannot read.
  const { hasAccess } = useApiAccess();

  const [prompt, setPrompt] = useState('');
  const [generating, setGenerating] = useState(false);
  const [presets, setPresets] = useState<BrandPreset[]>([]);
  const [presetId, setPresetId] = useState('');
  const [styleName, setStyleName] = useState('');
  const [styleText, setStyleText] = useState('#111111');
  const [styleBackground, setStyleBackground] = useState('#f5efe6');

  const [carousels, setCarousels] = useState<Carousel[]>([]);
  const [selected, setSelected] = useState<Carousel | null>(null);
  const [slides, setSlides] = useState<CarouselSlide[]>([]);
  const [slideIndex, setSlideIndex] = useState(0);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [status, setStatus] = useState('');

  const canvasElRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const fabricRef = useRef<Canvas | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openedFirst = useRef(false);

  const activePreset = presets.find((p) => p.id === presetId) ?? null;
  const look = lookOf(activePreset);
  const current = slides[slideIndex] ?? null;
  // Carousels made before generation was real carry template text marked
  // "[мок]". Said plainly, so one is never mistaken for the model's work.
  const isTemplate = slides.some((s) => s.body.startsWith('[мок]'));

  const openCarousel = useCallback(
    async (c: Carousel) => {
      try {
        const res = await api.getCarousel(config, c.id);
        setSelected(res.carousel);
        setSlides(res.slides);
        setSlideIndex(0);
        setPresetId(res.carousel.preset_id ?? '');
        setSaveState('idle');
      } catch (err) {
        setStatus(err instanceof Error ? err.message : String(err));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [apiKey, baseUrl]
  );

  const loadLibrary = useCallback(async () => {
    if (!hasAccess) return [];
    try {
      const [c, p] = await Promise.all([api.listCarousels(config), api.listBrandPresets(config)]);
      setCarousels(c.carousels);
      setPresets(p.presets);
      return c.carousels;
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
      return [];
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, baseUrl, hasAccess]);

  // Coming back to the screen opens the newest carousel: an empty studio
  // next to a list of finished work read as if the work had gone missing.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadLibrary().then((list) => {
      if (!openedFirst.current && list.length > 0) {
        openedFirst.current = true;
        void openCarousel(list[0]);
      }
    });
  }, [loadLibrary, openCarousel]);

  useEffect(
    () => () => {
      fabricRef.current?.dispose();
      fabricRef.current = null;
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    []
  );

  // The <canvas> exists only once a carousel is open, so the Fabric canvas is
  // created lazily here rather than on mount.
  useEffect(() => {
    if (!canvasElRef.current || !current) return;
    if (!fabricRef.current) {
      fabricRef.current = new Canvas(canvasElRef.current, { width: CANVAS_W, height: CANVAS_H, selection: false });
    }
    drawSlide(fabricRef.current, current, slideIndex, slides.length, look);
  }, [current, slideIndex, slides.length, look.background, look.text, look.font]); // eslint-disable-line react-hooks/exhaustive-deps

  // Shown smaller on a narrow screen, through Fabric rather than CSS: Fabric
  // draws on two stacked canvases inside its own wrapper, and resizing the
  // canvas elements from outside pulled them apart — the slide showed
  // cropped and shifted. cssOnly keeps the drawing resolution, so the
  // download is unaffected.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !selected) return;
    const fit = () => {
      const canvas = fabricRef.current;
      if (!canvas) return;
      const style = getComputedStyle(stage);
      const room = stage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const width = Math.max(200, Math.min(CANVAS_W, room));
      canvas.setDimensions({ width: `${width}px`, height: `${(width * CANVAS_H) / CANVAS_W}px` }, { cssOnly: true });
    };
    const observer = new ResizeObserver(fit);
    observer.observe(stage);
    fit();
    return () => observer.disconnect();
  }, [selected, current]);

  async function generate() {
    if (!prompt.trim() || generating) return;
    setGenerating(true);
    setStatus('');
    try {
      const res = await api.createCarousel(config, prompt.trim(), presetId || undefined);
      setSelected(res.carousel);
      setSlides(res.slides);
      setSlideIndex(0);
      setSaveState('idle');
      setPrompt('');
      await loadLibrary();
      setStatus(`Готово: ${count(res.slides.length, ['слайд', 'слайда', 'слайдов'])}. Текст правится справа от слайда.`);
    } catch (err) {
      setStatus(errorText(err));
    } finally {
      setGenerating(false);
    }
  }

  // Typed text shows on the slide at once and is saved a moment after the
  // typing stops — no button to forget.
  function edit(field: 'headline' | 'body', value: string) {
    if (!selected || !current) return;
    const slideId = current.id;
    const next = { ...current, [field]: value };
    setSlides((prev) => prev.map((s) => (s.id === slideId ? next : s)));
    setSaveState('saving');
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const carouselId = selected.id;
    saveTimer.current = setTimeout(async () => {
      try {
        await api.updateSlide(config, carouselId, slideId, { headline: next.headline, body: next.body });
        setSaveState('saved');
      } catch (err) {
        setSaveState('idle');
        setStatus(err instanceof Error ? err.message : String(err));
      }
    }, SAVE_DELAY_MS);
  }

  function downloadCurrent() {
    const canvas = fabricRef.current;
    if (!canvas) return;
    download(canvas.toDataURL({ format: 'png', multiplier: EXPORT_MULTIPLIER }), `slide-${slideIndex + 1}.png`);
  }

  // Every slide, drawn off screen with the same function as the preview.
  async function downloadAll() {
    const offscreen = new StaticCanvas(undefined, { width: CANVAS_W, height: CANVAS_H });
    for (let i = 0; i < slides.length; i++) {
      drawSlide(offscreen, slides[i], i, slides.length, look);
      download(offscreen.toDataURL({ format: 'png', multiplier: EXPORT_MULTIPLIER }), `slide-${i + 1}.png`);
      // Browsers drop downloads fired in the same instant.
      await new Promise((r) => setTimeout(r, 250));
    }
    offscreen.dispose();
  }

  // Picking a style while a carousel is open restyles that carousel, and it
  // stays restyled; with nothing open it is the style for the next one.
  function chooseStyle(id: string) {
    setPresetId(id);
    if (!selected) return;
    setSelected({ ...selected, preset_id: id || null });
    api.setCarouselStyle(config, selected.id, id || null).catch((err) => setStatus(err instanceof Error ? err.message : String(err)));
  }

  async function removeCarousel() {
    if (!selected || !window.confirm('Удалить карусель? Её слайды удалятся тоже.')) return;
    try {
      await api.deleteCarousel(config, selected.id);
      const list = await loadLibrary();
      setSelected(null);
      setSlides([]);
      if (list.length > 0) await openCarousel(list[0]);
      setStatus('Карусель удалена');
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  async function saveStyle() {
    if (!styleName.trim()) return setStatus('Назовите стиль — например, по названию блога');
    try {
      const res = await api.createBrandPreset(config, styleName.trim(), { primary_color: styleText, secondary_color: styleBackground });
      await loadLibrary();
      if (res?.preset?.id) chooseStyle(res.preset.id);
      setStyleName('');
      setStatus('Стиль сохранён и выбран');
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  const styleOptions = [
    { id: '', label: 'Обычный', hex: '#ffffff' },
    ...presets.map((p) => ({ id: p.id, label: p.name, hex: p.secondary_color })),
  ];

  return (
    <div className={styles.page}>
      <PageHeader section="Студия контента" title="Карусели" current="/carousels" />

      <div className={`${layout.twoPane} ${styles.workspace} ${selected ? styles.workspaceOpen : ''}`}>
        <aside className={`${layout.sidebar} ${styles.sidebar}`}>
          {!hasAccess && <NoticeBanner>{MISSING_API_KEY_MESSAGE}</NoticeBanner>}

          <section className={styles.block}>
            <h2 className={styles.blockTitle}>Новая карусель</h2>
            <textarea
              className={`${controls.input} ${styles.topic}`}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              placeholder="О чём карусель? Например: 5 ошибок новичков в йоге"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void generate();
              }}
            />
            <div className={styles.examples}>
              {EXAMPLES.map((example) => (
                <button key={example} type="button" className={styles.example} onClick={() => setPrompt(example)}>
                  {example}
                </button>
              ))}
            </div>
            <PillPicker label="Стиль" options={styleOptions} value={presetId} onChange={chooseStyle} />
            <button className={`${controls.buttonPrimary} ${styles.fullButton}`} onClick={generate} disabled={generating || !prompt.trim() || !hasAccess}>
              {generating ? 'Пишу слайды…' : 'Сгенерировать'}
            </button>
          </section>

          {carousels.length > 0 && (
            <section className={styles.block}>
              <h2 className={styles.blockTitle}>Мои карусели</h2>
              <ul className={styles.library}>
                {carousels.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      className={`${styles.libraryItem} ${c.id === selected?.id ? styles.libraryItemActive : ''}`}
                      onClick={() => openCarousel(c)}
                    >
                      <span className={styles.libraryPrompt}>{c.prompt}</span>
                      <span className={styles.libraryDate}>{new Date(c.created_at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className={styles.block}>
            <h2 className={styles.blockTitle}>Стиль бренда</h2>
            <p className={styles.blockHint}>Ваши цвета для всех каруселей — сохраните один раз.</p>
            <input className={controls.input} value={styleName} onChange={(e) => setStyleName(e.target.value)} placeholder="Название, например «Мой блог»" />
            <div className={styles.colors}>
              {/* The whole row is the target: a bare colour input is a ~20px
                  square, which is not something a finger hits on purpose. */}
              <label className={styles.colorRow}>
                <input type="color" value={styleBackground} onChange={(e) => setStyleBackground(e.target.value)} />
                <span>Фон</span>
              </label>
              <label className={styles.colorRow}>
                <input type="color" value={styleText} onChange={(e) => setStyleText(e.target.value)} />
                <span>Текст</span>
              </label>
              <span className={styles.stylePreview} style={{ background: styleBackground, color: styleText }} aria-hidden="true">Аа</span>
            </div>
            <button className={`${controls.buttonSecondary} ${styles.fullButton}`} onClick={saveStyle} disabled={!hasAccess}>
              Сохранить стиль
            </button>
          </section>
        </aside>

        <main className={`${layout.main} ${styles.main}`}>
          {!selected ? (
            <div className={styles.emptyState}>
              <div className={styles.emptyShape}>✦</div>
              <h2>Первая карусель — за минуту</h2>
              <p>Напишите тему или нажмите на пример. ИИ напишет слайды, а вы поправите текст и скачаете картинки для Instagram.</p>
            </div>
          ) : (
            <div className={styles.studio}>
              <div className={styles.studioHead}>
                <div>
                  <h2>{selected.prompt}</h2>
                  <span className={styles.meta}>
                    {count(slides.length, ['слайд', 'слайда', 'слайдов'])} · 1080×1350
                    {saveState === 'saving' && ' · сохраняю…'}
                    {saveState === 'saved' && ' · сохранено ✓'}
                  </span>
                </div>
                <div className={styles.downloads}>
                  <button type="button" className={styles.deleteLink} onClick={removeCarousel}>Удалить</button>
                  <button className={controls.buttonSecondary} onClick={downloadCurrent}>Скачать слайд</button>
                  <button className={controls.buttonPrimary} onClick={downloadAll}>Скачать все</button>
                </div>
              </div>

              {isTemplate && (
                <NoticeBanner>
                  Эта карусель создана шаблоном ещё до подключения ИИ — текст в ней не настоящий. Сгенерируйте её заново в блоке «Новая карусель», а эту можно удалить.
                </NoticeBanner>
              )}

              <div className={styles.editor}>
                <div className={styles.slideColumn}>
                  <div className={styles.canvasStage} ref={stageRef}>
                    <canvas ref={canvasElRef} />
                  </div>
                  <div className={styles.slideNav}>
                    <button type="button" className={styles.navButton} disabled={slideIndex === 0} onClick={() => setSlideIndex((i) => i - 1)} aria-label="Предыдущий слайд">‹</button>
                    <span>{slideIndex + 1} из {slides.length}</span>
                    <button type="button" className={styles.navButton} disabled={slideIndex === slides.length - 1} onClick={() => setSlideIndex((i) => i + 1)} aria-label="Следующий слайд">›</button>
                  </div>
                </div>

                {current && (
                  <div className={styles.fields}>
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>Заголовок слайда {slideIndex + 1}</span>
                      <input className={controls.input} value={current.headline} onChange={(e) => edit('headline', e.target.value)} />
                    </label>
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>Текст</span>
                      <textarea className={controls.input} value={current.body} onChange={(e) => edit('body', e.target.value)} rows={6} />
                    </label>
                    <PillPicker label="Стиль" options={styleOptions} value={presetId} onChange={chooseStyle} />
                  </div>
                )}
              </div>

              {/* Every slide at a glance — the dots this replaced said only
                  how many there were, not what was on them. */}
              <ol className={styles.thumbs}>
                {slides.map((s, i) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      className={`${styles.thumb} ${i === slideIndex ? styles.thumbActive : ''}`}
                      style={{ background: look.background, color: look.text }}
                      onClick={() => setSlideIndex(i)}
                      aria-label={`Слайд ${i + 1}: ${s.headline}`}
                    >
                      <span className={styles.thumbNumber}>{i + 1}</span>
                      <span className={styles.thumbText}>{s.headline}</span>
                    </button>
                  </li>
                ))}
              </ol>
            </div>
          )}

          <StatusMessage>{status}</StatusMessage>
        </main>
      </div>
      <TabBar current="/carousels" />
    </div>
  );
}

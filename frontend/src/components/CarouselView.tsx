'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Canvas, Rect, Textbox } from 'fabric';
import { api, type BrandPreset, type Carousel, type CarouselSlide } from '@/lib/api';
import { useDevConfig } from '@/lib/useDevConfig';
import { useApiAccess } from '@/lib/useApiAccess';
import ModuleNav from './ModuleNav';
import TabBar from './TabBar';
import NoticeBanner, { MISSING_API_KEY_MESSAGE } from './NoticeBanner';
import StatusMessage from './StatusMessage';
import controls from './Controls.module.css';
import styles from './CarouselView.module.css';
import layout from './Layout.module.css';

const CANVAS_W = 360;
const CANVAS_H = 450;

// The preset's actual primary/secondary colors, made visible wherever a
// preset is referenced — real per-preset data, not a placeholder icon.
function Swatch({ preset }: { preset: BrandPreset | null }) {
  if (!preset) return null;
  return (
    <span className={styles.swatch} title={preset.name}>
      <span className={styles.swatchHalf} style={{ background: preset.primary_color }} />
      <span className={styles.swatchHalf} style={{ background: preset.secondary_color }} />
    </span>
  );
}

export default function CarouselView() {
  const [devConfig] = useDevConfig();
  const { baseUrl, apiKey } = devConfig;
  const config = { baseUrl, apiKey };
  // Not the same as holding a key — see useApiAccess: the session is a cookie
  // this code cannot read.
  const { hasAccess } = useApiAccess();

  const [prompt, setPrompt] = useState('5 привычек продуктивности');
  const [presets, setPresets] = useState<BrandPreset[]>([]);
  const [presetId, setPresetId] = useState('');
  const [presetName, setPresetName] = useState('Мой бренд');
  const [presetColor, setPresetColor] = useState('#1a1a2e');

  const [carousels, setCarousels] = useState<Carousel[]>([]);
  const [selectedCarousel, setSelectedCarousel] = useState<Carousel | null>(null);
  const [slides, setSlides] = useState<CarouselSlide[]>([]);
  const [slideIndex, setSlideIndex] = useState(0);
  const [status, setStatus] = useState('');

  const canvasElRef = useRef<HTMLCanvasElement>(null);
  const fabricCanvasRef = useRef<Canvas | null>(null);
  const headlineBoxRef = useRef<Textbox | null>(null);
  const bodyBoxRef = useRef<Textbox | null>(null);

  const activePreset = presets.find((p) => p.id === presetId) ?? null;
  const currentSlide = slides[slideIndex] ?? null;

  const loadLibrary = useCallback(async () => {
    if (!hasAccess) return;
    try {
      const [c, p] = await Promise.all([api.listCarousels(config), api.listBrandPresets(config)]);
      setCarousels(c.carousels);
      setPresets(p.presets);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, baseUrl]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadLibrary();
  }, [loadLibrary]);

  // Unmount-only cleanup — creation happens lazily in the effect below
  // instead of here, because the <canvas> element only exists in the DOM
  // once selectedCarousel is set (it's behind that conditional in the JSX).
  // A mount-time-only effect (empty deps) runs before that's ever true, so
  // canvasElRef.current was always null and fabricCanvasRef.current never
  // got set — the canvas silently stayed at the browser's 300x150 default
  // and nothing ever drew onto it.
  useEffect(() => {
    return () => {
      fabricCanvasRef.current?.dispose();
      fabricCanvasRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!canvasElRef.current || !currentSlide) return;
    if (!fabricCanvasRef.current) {
      fabricCanvasRef.current = new Canvas(canvasElRef.current, { width: CANVAS_W, height: CANVAS_H });
    }
    const canvas = fabricCanvasRef.current;

    canvas.clear();
    const bg = new Rect({
      left: 0,
      top: 0,
      width: CANVAS_W,
      height: CANVAS_H,
      fill: activePreset?.secondary_color ?? '#ffffff',
      selectable: false,
    });
    const headline = new Textbox(currentSlide.headline, {
      left: 24,
      top: 40,
      width: CANVAS_W - 48,
      fontSize: 28,
      fontWeight: 'bold',
      fill: activePreset?.primary_color ?? '#111111',
      fontFamily: activePreset?.font_family ?? 'system-ui',
    });
    const body = new Textbox(currentSlide.body, {
      left: 24,
      top: 200,
      width: CANVAS_W - 48,
      fontSize: 16,
      fill: activePreset?.primary_color ?? '#111111',
      fontFamily: activePreset?.font_family ?? 'system-ui',
    });

    canvas.add(bg, headline, body);
    canvas.renderAll();
    headlineBoxRef.current = headline;
    bodyBoxRef.current = body;
  }, [currentSlide, activePreset]);

  async function generate() {
    if (!prompt.trim()) return;
    try {
      const res = await api.createCarousel(config, prompt.trim(), presetId || undefined);
      await loadLibrary();
      setSelectedCarousel(res.carousel);
      setSlides(res.slides);
      setSlideIndex(0);
      setStatus(`Карусель сгенерирована: ${res.slides.length} слайдов (мок-текст)`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  async function openCarousel(c: Carousel) {
    try {
      const res = await api.getCarousel(config, c.id);
      setSelectedCarousel(res.carousel);
      setSlides(res.slides);
      setSlideIndex(0);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  async function createPreset() {
    if (!presetName.trim()) return;
    try {
      await api.createBrandPreset(config, presetName.trim(), { primary_color: presetColor });
      await loadLibrary();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  // Double-click a text block on the canvas to edit it directly (Fabric's
  // Textbox is editable by default) — this reads back whatever the user
  // typed and persists it. Dragged positions are intentionally not saved,
  // only text content — see the note in schema.sql.
  async function saveEdits() {
    if (!selectedCarousel || !currentSlide || !headlineBoxRef.current || !bodyBoxRef.current) return;
    try {
      const res = await api.updateSlide(config, selectedCarousel.id, currentSlide.id, {
        headline: headlineBoxRef.current.text,
        body: bodyBoxRef.current.text,
      });
      setSlides((prev) => prev.map((s, i) => (i === slideIndex ? res.slide : s)));
      setStatus('Изменения сохранены');
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  function exportPng() {
    const canvas = fabricCanvasRef.current;
    if (!canvas) return;
    const dataUrl = canvas.toDataURL({ format: 'png', multiplier: 1 });
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = `slide-${slideIndex + 1}.png`;
    link.click();
  }

  return (
    <div className={styles.page}>
      <header className={layout.header}>
        <div className={styles.headerTitle}>
          <span className={styles.panelEyebrow}>СТУДИЯ КОНТЕНТА</span>
          <span className={layout.title}>Карусели</span>
        </div>
        <ModuleNav current="/carousels" />
      </header>

      <div className={`${layout.twoPane} ${styles.workspace}`}>
        <div className={`${layout.sidebar} ${styles.sidebar}`}>
          {!hasAccess && <NoticeBanner>{MISSING_API_KEY_MESSAGE}</NoticeBanner>}
          {/* The placeholder says what the field is; three stacked headings
              above it said it three more times. */}
          <input
            className={controls.input}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="О чём карусель?"
          />
          <div className={styles.presetRow}>
            <select className={controls.input} value={presetId} onChange={(e) => setPresetId(e.target.value)}>
              <option value="">без пресета</option>
              {presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <Swatch preset={activePreset} />
          </div>
          <button className={`${controls.buttonPrimary} ${styles.fullButton}`} onClick={generate}>Сгенерировать</button>

          <div className={styles.sectionLabel}>Бренд</div>
          <input className={controls.input} value={presetName} onChange={(e) => setPresetName(e.target.value)} placeholder="Название пресета" />
          {/* The whole row is the target: a bare colour input is a ~20px
              square, which is not something a finger hits on purpose. */}
          <label className={styles.colorRow}>
            <input type="color" value={presetColor} onChange={(e) => setPresetColor(e.target.value)} />
            <span>Основной цвет</span>
          </label>
          <button className={`${controls.buttonSecondary} ${styles.fullButton}`} onClick={createPreset}>Сохранить пресет</button>

          {carousels.length > 0 && <div className={styles.sectionLabel}>Последние карусели</div>}
          {carousels.map((c) => (
            <div
              key={c.id}
              onClick={() => openCarousel(c)}
              className={`${styles.libraryItem} ${c.id === selectedCarousel?.id ? styles.libraryItemActive : ''}`}
            >
              <Swatch preset={presets.find((p) => p.id === c.preset_id) ?? null} />
              <span className={styles.libraryItemPrompt}>{c.prompt}</span>
            </div>
          ))}
        </div>

        <div className={`${layout.main} ${styles.main}`}>
          {!selectedCarousel ? (
            <div className={styles.emptyState}><div className={styles.emptyShape}>✦</div><span className={styles.panelEyebrow}>ПУСТАЯ СТУДИЯ</span><h2>Здесь появится твоя карусель</h2><p>Сформулируй тему слева или выбери готовый проект из библиотеки.</p></div>
          ) : (
            <>
              <div className={styles.toolbar}>
                <button className={controls.buttonSecondary} disabled={slideIndex === 0} onClick={() => setSlideIndex((i) => i - 1)}>
                  ← слайд
                </button>
                {/* Real position among this carousel's actual slides, not a
                    decorative row — one dot per slide, exactly slides.length
                    of them. */}
                <span className={styles.dots}>
                  {slides.map((s, i) => (
                    <span key={s.id} className={`${styles.dot} ${i === slideIndex ? styles.dotActive : ''}`} />
                  ))}
                </span>
                <button className={controls.buttonSecondary} disabled={slideIndex === slides.length - 1} onClick={() => setSlideIndex((i) => i + 1)}>
                  слайд →
                </button>
                <button className={controls.buttonPrimary} onClick={saveEdits}>Сохранить правки</button>
                <button className={controls.buttonSecondary} onClick={exportPng}>Экспорт PNG</button>
              </div>
              <p className={styles.helper}>Дважды кликни по тексту на канвасе, чтобы отредактировать его.</p>
              <div className={styles.canvasStage}><canvas ref={canvasElRef} /></div>
            </>
          )}

          <StatusMessage>{status}</StatusMessage>
        </div>
      </div>
      <TabBar current="/carousels" />
    </div>
  );
}

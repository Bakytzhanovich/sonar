'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Canvas, Rect, Textbox } from 'fabric';
import { api, type BrandPreset, type Carousel, type CarouselSlide } from '@/lib/api';
import { useDevConfig } from '@/lib/useDevConfig';

const CANVAS_W = 360;
const CANVAS_H = 450;

export default function CarouselView() {
  const [devConfig] = useDevConfig();
  const { baseUrl, apiKey } = devConfig;
  const config = { baseUrl, apiKey };

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
    if (!apiKey) return;
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

  // Fabric canvas is created once; slides are drawn into it imperatively
  // whenever the current slide or preset changes (see the effect below).
  useEffect(() => {
    if (!canvasElRef.current) return;
    const canvas = new Canvas(canvasElRef.current, { width: CANVAS_W, height: CANVAS_H });
    fabricCanvasRef.current = canvas;
    return () => {
      canvas.dispose();
    };
  }, []);

  useEffect(() => {
    const canvas = fabricCanvasRef.current;
    if (!canvas || !currentSlide) return;

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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', fontFamily: 'system-ui, sans-serif' }}>
      <header style={{ padding: 12, borderBottom: '1px solid #ddd', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <strong>Sonar — Карусели (мок LLM, Fabric.js рендер)</strong>
        <span style={{ fontSize: 11, color: '#888' }}>
          {apiKey ? '' : 'Нет apiKey — зайди через редактор бота и нажми "Быстрый старт"'}
        </span>
        <Link href="/" style={{ marginLeft: 'auto' }}>
          ← Редактор бота
        </Link>
        <Link href="/reels">Рилсы →</Link>
        <Link href="/scheduler">Автопостинг →</Link>
        <Link href="/content-plan">Контент-план →</Link>
        <Link href="/video">Видео →</Link>
      </header>

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div style={{ width: 300, borderRight: '1px solid #ddd', padding: 12, overflowY: 'auto' }}>
          <h4>Промпт → карусель</h4>
          <input value={prompt} onChange={(e) => setPrompt(e.target.value)} style={{ width: '100%' }} />
          <select value={presetId} onChange={(e) => setPresetId(e.target.value)} style={{ width: '100%', margin: '4px 0' }}>
            <option value="">без пресета</option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button onClick={generate}>Сгенерировать (1 клик)</button>

          <h4 style={{ marginTop: 16 }}>Брендовый пресет</h4>
          <input value={presetName} onChange={(e) => setPresetName(e.target.value)} placeholder="название" style={{ width: '100%' }} />
          <input type="color" value={presetColor} onChange={(e) => setPresetColor(e.target.value)} />
          <button onClick={createPreset}>Сохранить пресет</button>

          <h4 style={{ marginTop: 16 }}>Библиотека каруселей</h4>
          {carousels.map((c) => (
            <div
              key={c.id}
              onClick={() => openCarousel(c)}
              style={{
                cursor: 'pointer',
                padding: 6,
                border: '1px solid #ccc',
                borderRadius: 4,
                marginBottom: 6,
                background: c.id === selectedCarousel?.id ? '#eef' : undefined,
                fontSize: 12,
              }}
            >
              {c.prompt}
            </div>
          ))}
        </div>

        <div style={{ flex: 1, padding: 12, overflowY: 'auto' }}>
          {!selectedCarousel ? (
            <p>Сгенерируй карусель или выбери из библиотеки слева.</p>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
                <button disabled={slideIndex === 0} onClick={() => setSlideIndex((i) => i - 1)}>
                  ← слайд
                </button>
                <span>
                  {slideIndex + 1} / {slides.length}
                </span>
                <button disabled={slideIndex === slides.length - 1} onClick={() => setSlideIndex((i) => i + 1)}>
                  слайд →
                </button>
                <button onClick={saveEdits}>Сохранить правки</button>
                <button onClick={exportPng}>Экспорт PNG</button>
              </div>
              <p style={{ fontSize: 11, color: '#888' }}>Дважды кликни по тексту на канвасе, чтобы отредактировать его.</p>
              <canvas ref={canvasElRef} style={{ border: '1px solid #ccc' }} />
            </>
          )}

          {status && <div style={{ fontSize: 12, color: '#555', marginTop: 8 }}>{status}</div>}
        </div>
      </div>
    </div>
  );
}

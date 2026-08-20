'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, type ConversationMessage, type LeadStatus, type Note, type Subscriber } from '@/lib/api';
import { useDevConfig } from '@/lib/useDevConfig';

const LEAD_STATUSES: LeadStatus[] = ['new', 'in_progress', 'client'];
const STATUS_LABEL: Record<LeadStatus, string> = { new: 'Новый', in_progress: 'В работе', client: 'Клиент' };

export default function CrmView() {
  const [devConfig, setDevConfig] = useDevConfig();
  const { baseUrl, apiKey, botId } = devConfig;
  const setBotId = (v: string) => setDevConfig((c) => ({ ...c, botId: v }));

  const [view, setView] = useState<'table' | 'kanban'>('table');
  const [tagFilter, setTagFilter] = useState('');
  const [leadStatusFilter, setLeadStatusFilter] = useState<LeadStatus | ''>('');
  const [subscribers, setSubscribers] = useState<Subscriber[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [newNote, setNewNote] = useState('');
  const [newTag, setNewTag] = useState('');
  const [status, setStatus] = useState('');

  const config = { baseUrl, apiKey };
  const selected = subscribers.find((s) => s.id === selectedId) ?? null;

  const loadSubscribers = useCallback(async () => {
    if (!botId) return;
    try {
      const res = await api.listSubscribers(config, botId, {
        tag: tagFilter || undefined,
        leadStatus: leadStatusFilter || undefined,
      });
      setSubscribers(res.subscribers);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botId, apiKey, baseUrl, tagFilter, leadStatusFilter]);

  useEffect(() => {
    // loadSubscribers only calls setState after an await (a network
    // response), never synchronously within this effect body — the
    // cascading-render case the lint rule guards against doesn't apply
    // to a standard fetch-on-mount/on-filter-change call.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadSubscribers();
  }, [loadSubscribers]);

  async function selectSubscriber(id: string) {
    setSelectedId(id);
    try {
      const [m, n] = await Promise.all([api.getMessages(config, id), api.getNotes(config, id)]);
      setMessages(m.messages);
      setNotes(n.notes);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  async function changeLeadStatus(id: string, leadStatus: LeadStatus) {
    try {
      await api.updateLeadStatus(config, id, leadStatus);
      await loadSubscribers();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  async function addTag() {
    if (!selected || !newTag.trim()) return;
    try {
      await api.addTag(config, selected.id, newTag.trim());
      setNewTag('');
      await loadSubscribers();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  async function removeTag(tagId: string) {
    if (!selected) return;
    try {
      await api.removeTag(config, selected.id, tagId);
      await loadSubscribers();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  async function addNote() {
    if (!selected || !newNote.trim()) return;
    try {
      await api.addNote(config, selected.id, newNote.trim());
      setNewNote('');
      const n = await api.getNotes(config, selected.id);
      setNotes(n.notes);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', fontFamily: 'system-ui, sans-serif' }}>
      <header style={{ padding: 12, borderBottom: '1px solid #ddd', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <strong>Sonar — CRM</strong>
        <input value={botId} onChange={(e) => setBotId(e.target.value)} placeholder="botId" style={{ width: 220 }} />
        <input value={tagFilter} onChange={(e) => setTagFilter(e.target.value)} placeholder="фильтр по тегу" style={{ width: 160 }} />
        <select value={leadStatusFilter} onChange={(e) => setLeadStatusFilter(e.target.value as LeadStatus | '')}>
          <option value="">все статусы</option>
          {LEAD_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        <button onClick={() => setView(view === 'table' ? 'kanban' : 'table')}>
          Вид: {view === 'table' ? 'Таблица' : 'Kanban'} (переключить)
        </button>
        <Link href="/" style={{ marginLeft: 'auto' }}>
          ← Редактор бота
        </Link>
        <Link href="/reels">Рилсы →</Link>
        <Link href="/carousels">Карусели →</Link>
        <Link href="/scheduler">Автопостинг →</Link>
        <Link href="/content-plan">Контент-план →</Link>
        <Link href="/video">Видео →</Link>
      </header>

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
          {!botId && <p>Укажи botId (или зайди через редактор бота и нажми &quot;Быстрый старт&quot;).</p>}

          {view === 'table' ? (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>
                  <th>Пользователь</th>
                  <th>Статус</th>
                  <th>Теги</th>
                  <th>Последнее взаимодействие</th>
                </tr>
              </thead>
              <tbody>
                {subscribers.map((s) => (
                  <tr
                    key={s.id}
                    onClick={() => selectSubscriber(s.id)}
                    style={{ cursor: 'pointer', background: s.id === selectedId ? '#eef' : undefined, borderBottom: '1px solid #eee' }}
                  >
                    <td>{s.external_user_id}</td>
                    <td>{STATUS_LABEL[s.lead_status]}</td>
                    <td>{s.tags.map((t) => t.name).join(', ')}</td>
                    <td>{new Date(s.last_interacted_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div style={{ display: 'flex', gap: 12 }}>
              {LEAD_STATUSES.map((columnStatus) => (
                <div key={columnStatus} style={{ flex: 1, border: '1px solid #ddd', borderRadius: 6, padding: 8 }}>
                  <h4>{STATUS_LABEL[columnStatus]}</h4>
                  {subscribers
                    .filter((s) => s.lead_status === columnStatus)
                    .map((s) => (
                      <div
                        key={s.id}
                        onClick={() => selectSubscriber(s.id)}
                        style={{
                          border: '1px solid #ccc',
                          borderRadius: 4,
                          padding: 8,
                          marginBottom: 8,
                          cursor: 'pointer',
                          background: s.id === selectedId ? '#eef' : '#fff',
                        }}
                      >
                        <div>{s.external_user_id}</div>
                        <div style={{ fontSize: 11, color: '#666' }}>{s.tags.map((t) => t.name).join(', ')}</div>
                        {/* No drag-and-drop for MVP — a plain select is the honest, low-effort way to move a card between columns. */}
                        <select value={s.lead_status} onChange={(e) => changeLeadStatus(s.id, e.target.value as LeadStatus)}>
                          {LEAD_STATUSES.map((opt) => (
                            <option key={opt} value={opt}>
                              {STATUS_LABEL[opt]}
                            </option>
                          ))}
                        </select>
                      </div>
                    ))}
                </div>
              ))}
            </div>
          )}
        </div>

        <aside style={{ width: 360, borderLeft: '1px solid #ddd', padding: 12, overflowY: 'auto' }}>
          {!selected ? (
            <p>Выбери подписчика слева.</p>
          ) : (
            <>
              <h3>{selected.external_user_id}</h3>

              <label>
                Статус лида
                <select
                  value={selected.lead_status}
                  onChange={(e) => changeLeadStatus(selected.id, e.target.value as LeadStatus)}
                  style={{ display: 'block', width: '100%' }}
                >
                  {LEAD_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {STATUS_LABEL[s]}
                    </option>
                  ))}
                </select>
              </label>

              <div style={{ margin: '8px 0' }}>
                <div>
                  {selected.tags.map((t) => (
                    <span key={t.id} style={{ display: 'inline-block', background: '#eee', borderRadius: 12, padding: '2px 8px', marginRight: 4 }}>
                      {t.name} <button onClick={() => removeTag(t.id)}>×</button>
                    </span>
                  ))}
                </div>
                <input value={newTag} onChange={(e) => setNewTag(e.target.value)} placeholder="новый тег" style={{ width: '70%' }} />
                <button onClick={addTag}>+ тег</button>
              </div>

              <h4>Переписка</h4>
              <div style={{ maxHeight: 200, overflowY: 'auto', border: '1px solid #eee', padding: 6 }}>
                {messages.map((m, i) => (
                  <div key={i} style={{ textAlign: m.direction === 'in' ? 'left' : 'right', margin: '4px 0' }}>
                    <span style={{ background: m.direction === 'in' ? '#f0f0f0' : '#dbeafe', borderRadius: 8, padding: '4px 8px', display: 'inline-block' }}>
                      {m.content}
                    </span>
                  </div>
                ))}
                {messages.length === 0 && <p style={{ color: '#888' }}>Пока нет сообщений</p>}
              </div>

              <h4>Заметки</h4>
              <textarea value={newNote} onChange={(e) => setNewNote(e.target.value)} rows={2} style={{ width: '100%' }} />
              <button onClick={addNote}>Добавить заметку</button>
              <ul>
                {notes.map((n) => (
                  <li key={n.id}>
                    {n.body} <span style={{ fontSize: 10, color: '#888' }}>{new Date(n.created_at).toLocaleString()}</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          {status && <div style={{ fontSize: 12, color: '#555' }}>{status}</div>}
        </aside>
      </div>
    </div>
  );
}

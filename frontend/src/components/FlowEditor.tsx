'use client';

import { useCallback, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  addEdge,
  applyNodeChanges,
  applyEdgeChanges,
  type Node,
  type Edge,
  type Connection,
  type NodeChange,
  type EdgeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { api, ApiError, type ApiConfig, type FlowDefinition, type MatchType, type FallbackChannel } from '@/lib/api';
import { useDevConfig } from '@/lib/useDevConfig';
import Link from 'next/link';

type TriggerData = { kind: 'trigger'; label: string; keyword: string; matchType: MatchType };
type MessageData = { kind: 'send_message'; label: string; text: string; fallbackChannel?: FallbackChannel };
type CanvasData = TriggerData | MessageData;
type CanvasNode = Node<CanvasData>;

function triggerLabel(keyword: string, matchType: MatchType) {
  return `Триггер: "${keyword}" (${matchType})`;
}

function messageLabel(text: string) {
  return `Сообщение: ${text.slice(0, 40)}${text.length > 40 ? '…' : ''}`;
}

function newTriggerNode(): CanvasNode {
  return {
    id: crypto.randomUUID(),
    position: { x: 80, y: 80 },
    data: { kind: 'trigger', label: triggerLabel('цена', 'contains'), keyword: 'цена', matchType: 'contains' },
  };
}

function newMessageNode(x: number, y: number): CanvasNode {
  const text = 'Новый текст сообщения';
  return { id: crypto.randomUUID(), position: { x, y }, data: { kind: 'send_message', label: messageLabel(text), text } };
}

function toWireDefinition(nodes: CanvasNode[], edges: Edge[]): FlowDefinition {
  return {
    nodes: nodes.map((n) =>
      n.data.kind === 'trigger'
        ? { id: n.id, type: 'trigger', position: n.position, data: { keyword: n.data.keyword, matchType: n.data.matchType } }
        : {
            id: n.id,
            type: 'send_message',
            position: n.position,
            data: n.data.fallbackChannel ? { text: n.data.text, fallbackChannel: n.data.fallbackChannel } : { text: n.data.text },
          }
    ),
    edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
  };
}

function fromWireDefinition(def: FlowDefinition): { nodes: CanvasNode[]; edges: Edge[] } {
  const nodes: CanvasNode[] = def.nodes.map((n) => {
    if (n.type === 'trigger') {
      const d = n.data as { keyword: string; matchType: MatchType };
      return { id: n.id, position: n.position, data: { kind: 'trigger', label: triggerLabel(d.keyword, d.matchType), ...d } };
    }
    const d = n.data as { text: string; fallbackChannel?: FallbackChannel };
    return { id: n.id, position: n.position, data: { kind: 'send_message', label: messageLabel(d.text), ...d } };
  });
  const edges: Edge[] = def.edges.map((e) => ({ id: e.id, source: e.source, target: e.target }));
  return { nodes, edges };
}

export default function FlowEditor() {
  const [devConfig, setDevConfig] = useDevConfig();
  const { baseUrl, apiKey, botId, externalAccountId } = devConfig;
  const setBaseUrl = (v: string) => setDevConfig((c) => ({ ...c, baseUrl: v }));
  const setApiKey = (v: string) => setDevConfig((c) => ({ ...c, apiKey: v }));
  const setBotId = (v: string) => setDevConfig((c) => ({ ...c, botId: v }));
  const [status, setStatus] = useState<string>('');
  const [errors, setErrors] = useState<string[]>([]);

  // Lazy initializer: runs once on mount, not on every render.
  const [nodes, setNodes] = useState<CanvasNode[]>(() => [newTriggerNode()]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [flowId, setFlowId] = useState<string | null>(null);
  const [flowVersion, setFlowVersion] = useState<number | null>(null);
  const [flowStatus, setFlowStatus] = useState<string | null>(null);
  const [loadFlowId, setLoadFlowId] = useState('');
  const [loadVersion, setLoadVersion] = useState('1');

  const [dashboard, setDashboard] = useState<unknown>(null);
  const [testUser, setTestUser] = useState('preview-user');
  const [testMessage, setTestMessage] = useState('цена?');
  const [webhookUser, setWebhookUser] = useState('real-user-1');
  const [webhookMessage, setWebhookMessage] = useState('цена?');

  const config: ApiConfig = { baseUrl, apiKey };
  const hasTrigger = nodes.some((n) => n.data.kind === 'trigger');
  const selectedNode = nodes.find((n) => n.id === selectedId) ?? null;

  const onNodesChange = useCallback((changes: NodeChange[]) => setNodes((nds) => applyNodeChanges(changes, nds) as CanvasNode[]), []);
  const onEdgesChange = useCallback((changes: EdgeChange[]) => setEdges((eds) => applyEdgeChanges(changes, eds)), []);
  const onConnect = useCallback((connection: Connection) => setEdges((eds) => addEdge(connection, eds)), []);

  function updateSelectedData(patch: Partial<TriggerData> | Partial<MessageData>) {
    if (!selectedId) return;
    setNodes((nds) =>
      nds.map((n) => {
        if (n.id !== selectedId) return n;
        if (n.data.kind === 'trigger') {
          const next = { ...n.data, ...(patch as Partial<TriggerData>) } as TriggerData;
          return { ...n, data: { ...next, label: triggerLabel(next.keyword, next.matchType) } };
        }
        const next = { ...n.data, ...(patch as Partial<MessageData>) } as MessageData;
        return { ...n, data: { ...next, label: messageLabel(next.text) } };
      })
    );
  }

  function addTrigger() {
    if (hasTrigger) return; // backend requires exactly one — mirrored client-side
    setNodes((nds) => [...nds, newTriggerNode()]);
  }

  function addMessage() {
    const anchor = selectedNode ?? nodes[nodes.length - 1];
    const node = newMessageNode((anchor?.position.x ?? 80) + 220, (anchor?.position.y ?? 80) + 40 * nodes.length);
    setNodes((nds) => [...nds, node]);
    if (anchor) setEdges((eds) => addEdge({ id: crypto.randomUUID(), source: anchor.id, target: node.id }, eds));
  }

  async function saveDraft() {
    setErrors([]);
    if (!botId) return setStatus('Укажи botId');
    try {
      const definition = toWireDefinition(nodes, edges);
      if (!flowId) {
        const res = await api.createFlow(config, botId, definition);
        setFlowId(res.flow.id);
        setFlowVersion(res.flow.version);
        setFlowStatus(res.flow.status);
        setStatus(`Черновик создан: ${res.flow.id} v${res.flow.version}`);
      } else {
        const res = await api.createFlowVersion(config, flowId, definition);
        setFlowVersion(res.flow.version);
        setFlowStatus(res.flow.status);
        setStatus(`Новая версия черновика: v${res.flow.version}`);
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  async function publish() {
    setErrors([]);
    if (!flowId || flowVersion === null) return setStatus('Сначала сохрани черновик');
    try {
      const res = await api.publishFlow(config, flowId, flowVersion);
      setFlowStatus(res.flow.status);
      setStatus(`Опубликовано: v${res.flow.version}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 422 && Array.isArray((err.body as { errors?: string[] })?.errors)) {
        setErrors((err.body as { errors: string[] }).errors);
        setStatus('Публикация отклонена — см. ошибки ниже');
      } else {
        setStatus(err instanceof Error ? err.message : String(err));
      }
    }
  }

  async function loadFlow() {
    setErrors([]);
    try {
      const res = await api.getFlowVersion(config, loadFlowId, Number(loadVersion));
      const { nodes: n, edges: e } = fromWireDefinition(res.flow.definition);
      setNodes(n);
      setEdges(e);
      setFlowId(res.flow.id);
      setFlowVersion(res.flow.version);
      setFlowStatus(res.flow.status);
      setStatus(`Загружено: ${res.flow.id} v${res.flow.version} (${res.flow.status})`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  async function bindTrigger() {
    const triggerNode = nodes.find((n): n is CanvasNode & { data: TriggerData } => n.data.kind === 'trigger');
    if (!triggerNode || !flowId || flowVersion === null) return setStatus('Нужен опубликованный флоу с триггером');
    try {
      const res = await api.createTrigger(config, botId, {
        keyword: triggerNode.data.keyword,
        matchType: triggerNode.data.matchType,
        flowId,
        flowVersion,
      });
      setStatus(`Триггер привязан: "${res.trigger.keyword}" -> v${res.trigger.flow_version}`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  async function runTest() {
    if (!botId) return setStatus('Укажи botId');
    try {
      const res = await api.testRun(config, botId, { externalUserId: testUser, messageText: testMessage });
      setStatus(`Тест: ${JSON.stringify(res.outcome)}`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  async function refreshDashboard() {
    if (!botId) return setStatus('Укажи botId');
    try {
      setDashboard(await api.dashboard(config, botId));
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  async function quickSetup() {
    try {
      const email = `demo-${Date.now()}@example.com`;
      const tenant = await api.createTenant(config, 'Demo Blogger', email);
      const accountId = `ig-${Date.now()}`;
      const bot = await api.createBot({ baseUrl, apiKey: tenant.apiKey }, 'Demo Bot', accountId);
      setDevConfig((c) => ({ ...c, apiKey: tenant.apiKey, botId: bot.bot.id, externalAccountId: accountId }));
      setStatus('Тестовый tenant + бот созданы');
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  // Sends a REAL (non-test) inbound message through the mock webhook —
  // unlike "Тест-режим" below, this persists (subscriber, messages,
  // flow_runs), so it's what actually populates the CRM at /crm.
  async function sendWebhook() {
    if (!externalAccountId) return setStatus('Нет externalAccountId — сначала "Быстрый старт" или создай бота с ним вручную');
    try {
      const res = await api.sendMockWebhook(config, externalAccountId, webhookUser, webhookMessage);
      setStatus(`Вебхук: ${JSON.stringify(res)}`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', fontFamily: 'system-ui, sans-serif' }}>
      <header style={{ padding: 12, borderBottom: '1px solid #ddd', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <strong>Sonar — редактор бота</strong>
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="API base URL" style={{ width: 200 }} />
        <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="apiKey" style={{ width: 220 }} />
        <input value={botId} onChange={(e) => setBotId(e.target.value)} placeholder="botId" style={{ width: 220 }} />
        <button onClick={quickSetup}>Быстрый старт (создать tenant+бота)</button>
        <Link href="/crm" style={{ marginLeft: 'auto' }}>
          CRM →
        </Link>
        <Link href="/reels">Рилсы →</Link>
        <Link href="/carousels">Карусели →</Link>
        <Link href="/scheduler">Автопостинг →</Link>
        <Link href="/content-plan">Контент-план →</Link>
        <Link href="/video">Видео →</Link>
      </header>

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
          <ReactFlow nodes={nodes} edges={edges} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} onNodeClick={(_, n) => setSelectedId(n.id)} onPaneClick={() => setSelectedId(null)} fitView>
            <Background />
            <Controls />
          </ReactFlow>
        </div>

        <aside style={{ width: 320, borderLeft: '1px solid #ddd', padding: 12, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <h4>Инструменты</h4>
            <button onClick={addTrigger} disabled={hasTrigger} title={hasTrigger ? 'Уже есть триггер — разрешён только один' : ''}>
              + Триггер
            </button>{' '}
            <button onClick={addMessage}>+ Сообщение</button>
          </div>

          {selectedNode && (
            <div>
              <h4>Свойства узла</h4>
              {selectedNode.data.kind === 'trigger' ? (
                <>
                  <label>
                    Ключевое слово
                    <input value={selectedNode.data.keyword} onChange={(e) => updateSelectedData({ keyword: e.target.value })} style={{ display: 'block', width: '100%' }} />
                  </label>
                  <label>
                    Тип совпадения
                    <select value={selectedNode.data.matchType} onChange={(e) => updateSelectedData({ matchType: e.target.value as MatchType })} style={{ display: 'block', width: '100%' }}>
                      <option value="contains">contains</option>
                      <option value="exact">exact</option>
                    </select>
                  </label>
                </>
              ) : (
                <>
                  <label>
                    Текст сообщения
                    <textarea value={selectedNode.data.text} onChange={(e) => updateSelectedData({ text: e.target.value })} style={{ display: 'block', width: '100%' }} rows={4} />
                  </label>
                  <label>
                    Fallback-канал вне 24ч окна
                    <select
                      value={selectedNode.data.fallbackChannel ?? ''}
                      onChange={(e) => updateSelectedData({ fallbackChannel: (e.target.value || undefined) as FallbackChannel | undefined })}
                      style={{ display: 'block', width: '100%' }}
                    >
                      <option value="">нет (провалится вне окна)</option>
                      <option value="comment_reply">comment_reply</option>
                    </select>
                  </label>
                </>
              )}
            </div>
          )}

          <div>
            <h4>Флоу {flowId ? `(${flowId.slice(0, 8)}… v${flowVersion} — ${flowStatus})` : '(не сохранён)'}</h4>
            <button onClick={saveDraft}>Сохранить черновик</button>{' '}
            <button onClick={publish} disabled={!flowId}>
              Опубликовать
            </button>{' '}
            <button onClick={bindTrigger} disabled={!flowId}>
              Привязать триггер к боту
            </button>
          </div>

          <div>
            <h4>Загрузить существующий флоу</h4>
            <input value={loadFlowId} onChange={(e) => setLoadFlowId(e.target.value)} placeholder="flowId" style={{ width: '100%' }} />
            <input value={loadVersion} onChange={(e) => setLoadVersion(e.target.value)} placeholder="версия" style={{ width: 80 }} />
            <button onClick={loadFlow}>Загрузить</button>
          </div>

          <div>
            <h4>Тест-режим</h4>
            <p style={{ fontSize: 11, color: '#888', margin: '2px 0' }}>Ничего не пишет в БД — в CRM не появится.</p>
            <input value={testUser} onChange={(e) => setTestUser(e.target.value)} placeholder="externalUserId" style={{ width: '100%' }} />
            <input value={testMessage} onChange={(e) => setTestMessage(e.target.value)} placeholder="сообщение" style={{ width: '100%' }} />
            <button onClick={runTest}>Отправить тестовое сообщение</button>
          </div>

          <div>
            <h4>Мок-вебхук (реальное сообщение)</h4>
            <p style={{ fontSize: 11, color: '#888', margin: '2px 0' }}>Пишет в БД по-настоящему — появится в /crm.</p>
            <input value={webhookUser} onChange={(e) => setWebhookUser(e.target.value)} placeholder="externalUserId" style={{ width: '100%' }} />
            <input value={webhookMessage} onChange={(e) => setWebhookMessage(e.target.value)} placeholder="сообщение" style={{ width: '100%' }} />
            <button onClick={sendWebhook}>Отправить как реальный вебхук</button>
          </div>

          <div>
            <h4>Дашборд</h4>
            <button onClick={refreshDashboard}>Обновить</button>
            <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap' }}>{dashboard ? JSON.stringify(dashboard, null, 2) : '—'}</pre>
          </div>

          {errors.length > 0 && (
            <div style={{ color: '#b00020' }}>
              <h4>Ошибки валидации</h4>
              <ul>
                {errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </div>
          )}

          {status && <div style={{ fontSize: 12, color: '#555', wordBreak: 'break-word' }}>{status}</div>}
        </aside>
      </div>
    </div>
  );
}

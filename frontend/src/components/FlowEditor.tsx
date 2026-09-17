'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  addEdge,
  applyNodeChanges,
  applyEdgeChanges,
  type Node,
  type NodeProps,
  type NodeTypes,
  type Edge,
  type Connection,
  type NodeChange,
  type EdgeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { api, ApiError, type ApiConfig, type FlowDefinition, type MatchType, type FallbackChannel } from '@/lib/api';
import Link from 'next/link';
import { useDevConfig } from '@/lib/useDevConfig';
import { useApiAccess } from '@/lib/useApiAccess';
import ModuleNav from './ModuleNav';
import TabBar from './TabBar';
import Select from './Select';
import styles from './FlowEditor.module.css';
import controls from './Controls.module.css';

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
    type: 'trigger',
    position: { x: 80, y: 80 },
    data: { kind: 'trigger', label: triggerLabel('план', 'contains'), keyword: 'план', matchType: 'contains' },
  };
}

function newMessageNode(x: number, y: number): CanvasNode {
  const text = 'Отправлю чек-лист. Подскажите, вы запускаете курс или консультацию?';
  return { id: crypto.randomUUID(), type: 'send_message', position: { x, y }, data: { kind: 'send_message', label: messageLabel(text), text } };
}

function newStarterDefinition(): { nodes: CanvasNode[]; edges: Edge[] } {
  const trigger = newTriggerNode();
  const message = newMessageNode(340, 80);
  return {
    nodes: [trigger, message],
    edges: [{ id: crypto.randomUUID(), source: trigger.id, target: message.id }],
  };
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
      return { id: n.id, type: 'trigger', position: n.position, data: { kind: 'trigger', label: triggerLabel(d.keyword, d.matchType), ...d } };
    }
    const d = n.data as { text: string; fallbackChannel?: FallbackChannel };
    return { id: n.id, type: 'send_message', position: n.position, data: { kind: 'send_message', label: messageLabel(d.text), ...d } };
  });
  const edges: Edge[] = def.edges.map((e) => ({ id: e.id, source: e.source, target: e.target }));
  return { nodes, edges };
}

// Feather-style inline paths — no icon library in this project's deps yet,
// and two glyphs don't justify adding one.
function ZapIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );
}

function MessageIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

// Card look + type color + selection ring live here, on custom node types,
// because ReactFlow's default node is a bare rectangle with a text label —
// not the trigger/condition/action card convention this category uses.
function TriggerNode({ data, selected }: NodeProps<Node<TriggerData>>) {
  return (
    <div className={`${styles.node} ${styles.nodeTrigger} ${selected ? styles.nodeSelected : ''}`}>
      <Handle type="source" position={Position.Right} className={styles.handle} />
      <div className={styles.nodeHeader}>
        <span className={styles.nodeIcon}>
          <ZapIcon />
        </span>
        <span className={styles.nodeTitle}>Триггер</span>
      </div>
      <div className={styles.nodeSubtitle}>
        &ldquo;{data.keyword}&rdquo; · {data.matchType}
      </div>
    </div>
  );
}

function ActionNode({ data, selected }: NodeProps<Node<MessageData>>) {
  return (
    <div className={`${styles.node} ${styles.nodeAction} ${selected ? styles.nodeSelected : ''}`}>
      <Handle type="target" position={Position.Left} className={styles.handle} />
      <Handle type="source" position={Position.Right} className={styles.handle} />
      <div className={styles.nodeHeader}>
        <span className={styles.nodeIcon}>
          <MessageIcon />
        </span>
        <span className={styles.nodeTitle}>Сообщение</span>
      </div>
      <div className={styles.nodeSubtitle}>{data.text.slice(0, 60)}{data.text.length > 60 ? '…' : ''}</div>
    </div>
  );
}

// Module-scope so the reference is stable across renders — passing a fresh
// object to ReactFlow's nodeTypes prop every render defeats its memoization.
const nodeTypes: NodeTypes = { trigger: TriggerNode, send_message: ActionNode };

export default function FlowEditor() {
  const [devConfig, setDevConfig] = useDevConfig();
  // A signed-in user's credential is a cookie this code cannot see.
  const { hasAccess } = useApiAccess();
  // externalAccountId is no longer read here: the "входящее сообщение" panel
  // used to need it to address the public mock webhook, and now posts to the
  // tenant-scoped /api/bots/:botId/simulate-incoming instead. It stays in
  // useDevConfig because creating a bot still sets it.
  const { baseUrl, apiKey, botId, devMode } = devConfig;
  const setApiKey = (v: string) => setDevConfig((c) => ({ ...c, apiKey: v }));
  const setBotId = (v: string) => setDevConfig((c) => ({ ...c, botId: v }));
  const setDevMode = (v: boolean) => setDevConfig((c) => ({ ...c, devMode: v }));
  const [status, setStatus] = useState<string>('');
  const [errors, setErrors] = useState<string[]>([]);

  // A first-time user starts with a valid two-node scenario rather than an
  // incomplete trigger that cannot be published. Existing workspaces are
  // loaded over this starter as soon as their bot configuration is known.
  const [starter] = useState(newStarterDefinition);
  const [nodes, setNodes] = useState<CanvasNode[]>(starter.nodes);
  const [edges, setEdges] = useState<Edge[]>(starter.edges);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [flowId, setFlowId] = useState<string | null>(null);
  const [flowVersion, setFlowVersion] = useState<number | null>(null);
  const [flowStatus, setFlowStatus] = useState<string | null>(null);
  const [loadFlowId, setLoadFlowId] = useState('');
  const [loadVersion, setLoadVersion] = useState('1');
  // What bindTrigger() last successfully bound — not a plain boolean, so
  // "is it still bound" is *derived* every render (see triggerBound below)
  // instead of being a flag this component has to remember to clear at
  // every action that could invalidate it. A boolean flag missed two real
  // cases (switching botId, deleting the trigger node) before this;
  // deriving it structurally can't miss a future one the same way.
  const [boundTrigger, setBoundTrigger] = useState<{
    botId: string;
    flowId: string;
    flowVersion: number;
    keyword: string;
    matchType: MatchType;
  } | null>(null);

  const [dashboard, setDashboard] = useState<unknown>(null);
  const [testUser, setTestUser] = useState('preview-user');
  const [testMessage, setTestMessage] = useState('хочу план запуска');
  const [webhookUser, setWebhookUser] = useState('real-user-1');
  const [webhookMessage, setWebhookMessage] = useState('хочу план запуска');
  const autoLoadAttemptRef = useRef<string | null>(null);

  const config: ApiConfig = { baseUrl, apiKey };
  const hasTrigger = nodes.some((n) => n.data.kind === 'trigger');
  const selectedNode = nodes.find((n) => n.id === selectedId) ?? null;
  const triggerNode = nodes.find((n): n is CanvasNode & { data: TriggerData } => n.data.kind === 'trigger') ?? null;
  const triggerBound =
    boundTrigger !== null &&
    boundTrigger.botId === botId &&
    boundTrigger.flowId === flowId &&
    boundTrigger.flowVersion === flowVersion &&
    triggerNode !== null &&
    boundTrigger.keyword === triggerNode.data.keyword &&
    boundTrigger.matchType === triggerNode.data.matchType;

  const onNodesChange = useCallback((changes: NodeChange[]) => setNodes((nds) => applyNodeChanges(changes, nds) as CanvasNode[]), []);
  const onEdgesChange = useCallback((changes: EdgeChange[]) => setEdges((eds) => applyEdgeChanges(changes, eds)), []);
  const onConnect = useCallback((connection: Connection) => setEdges((eds) => addEdge(connection, eds)), []);

  useEffect(() => {
    if (!hasAccess || !botId || flowId || autoLoadAttemptRef.current === botId) return;
    autoLoadAttemptRef.current = botId;

    api
      .listFlows(config, botId)
      .then(async (listed) => {
        const latest = listed.flows?.[0];
        if (!latest) return;
        const res = await api.getFlowVersion(config, latest.id, latest.version);
        const restored = fromWireDefinition(res.flow.definition);
        setNodes(restored.nodes);
        setEdges(restored.edges);
        setFlowId(res.flow.id);
        setFlowVersion(res.flow.version);
        setFlowStatus(res.flow.status);
        setStatus('Рабочий сценарий загружен');
      })
      .catch((err) => {
        autoLoadAttemptRef.current = null;
        setStatus(err instanceof Error ? err.message : String(err));
      });
    // config is derived from these primitive fields; including the object
    // itself would retrigger this effect on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, baseUrl, botId, flowId]);

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
    if (!triggerNode || !flowId || flowVersion === null) return setStatus('Нужен опубликованный флоу с триггером');
    try {
      const res = await api.createTrigger(config, botId, {
        keyword: triggerNode.data.keyword,
        matchType: triggerNode.data.matchType,
        flowId,
        flowVersion,
      });
      setBoundTrigger(
        res.trigger.is_active ? { botId, flowId, flowVersion, keyword: res.trigger.keyword, matchType: res.trigger.match_type } : null
      );
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

  // Sends a REAL (non-test) inbound message through the authenticated
  // simulator route — unlike "Тест-режим" below, this persists (subscriber,
  // messages, flow_runs), so it's what actually populates the CRM at /crm.
  // Requires only the bot id now, not its externalAccountId: the server
  // resolves the bot within this tenant.
  async function sendWebhook() {
    if (!botId) return setStatus('Нет бота — сначала "Быстрый старт" или создай бота вручную');
    try {
      const res = await api.simulateIncoming(config, botId, webhookUser, webhookMessage);
      setStatus(`Входящее сообщение: ${JSON.stringify(res)}`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', fontFamily: 'system-ui, sans-serif' }}>
      <header className={styles.header}>
        <span className={styles.title}>Sonar — редактор бота</span>
        <ModuleNav current="/bot" />
      </header>

      <div className={styles.body}>
        <div className={styles.canvasWrap}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, n) => setSelectedId(n.id)}
            onPaneClick={() => setSelectedId(null)}
            fitView
          >
            <Background variant={BackgroundVariant.Dots} color="var(--canvas-dot)" gap={18} size={1.5} />
            <Controls />
          </ReactFlow>
        </div>

        <aside className={styles.sidebar}>
          {(!hasAccess || !botId) && (
            <div className={styles.setupNotice}>
              <strong>Начните с демо-пространства</strong>
              <p>Sonar подготовит первый связанный сценарий без API-ключей и технических идентификаторов.</p>
              <Link href="/onboarding" className={controls.buttonPrimary}>
                Пройти первый запуск
              </Link>
            </div>
          )}

          <div className={styles.card}>
            <h4 className={styles.cardTitle}>Инструменты</h4>
            <div className={styles.row}>
              <button className={controls.buttonSecondary} onClick={addTrigger} disabled={hasTrigger} title={hasTrigger ? 'Уже есть триггер — разрешён только один' : ''}>
                + Триггер
              </button>
              <button className={controls.buttonSecondary} onClick={addMessage}>
                + Сообщение
              </button>
            </div>
          </div>

          {selectedNode && (
            <div className={styles.card}>
              <h4 className={styles.cardTitle}>Свойства узла</h4>
              {selectedNode.data.kind === 'trigger' ? (
                <>
                  <label>
                    Ключевое слово
                    <input className={controls.input} value={selectedNode.data.keyword} onChange={(e) => updateSelectedData({ keyword: e.target.value })} style={{ display: 'block', width: '100%', marginTop: 4 }} />
                  </label>
                  <label>
                    Тип совпадения
                    <Select
                      className={styles.inspectorSelect}
                      value={selectedNode.data.matchType}
                      onChange={(next) => updateSelectedData({ matchType: next as MatchType })}
                      aria-label="Тип совпадения"
                      options={[
                        { value: 'contains', label: 'contains' },
                        { value: 'exact', label: 'exact' },
                      ]}
                    />
                  </label>
                </>
              ) : (
                <>
                  <label>
                    Текст сообщения
                    <textarea className={controls.input} value={selectedNode.data.text} onChange={(e) => updateSelectedData({ text: e.target.value })} style={{ display: 'block', width: '100%', marginTop: 4 }} rows={4} />
                  </label>
                  <label>
                    Fallback-канал вне 24ч окна
                    <Select
                      className={styles.inspectorSelect}
                      value={selectedNode.data.fallbackChannel ?? ''}
                      onChange={(next) => updateSelectedData({ fallbackChannel: (next || undefined) as FallbackChannel | undefined })}
                      aria-label="Запасной канал"
                      options={[
                        { value: '', label: 'нет (провалится вне окна)' },
                        { value: 'comment_reply', label: 'comment_reply' },
                      ]}
                    />
                  </label>
                </>
              )}
            </div>
          )}

          <div className={styles.card}>
            <h4 className={styles.cardTitle}>Флоу {flowId ? `(${flowId.slice(0, 8)}… v${flowVersion} — ${flowStatus})` : '(не сохранён)'}</h4>
            <div className={styles.row}>
              <button className={controls.buttonSecondary} onClick={saveDraft} disabled={!botId}>
                Сохранить черновик
              </button>
              <button className={controls.buttonPrimary} onClick={publish} disabled={!flowId}>
                Опубликовать
              </button>
              <button className={controls.buttonSecondary} onClick={bindTrigger} disabled={!flowId}>
                Привязать триггер к боту
              </button>
            </div>
            {triggerBound && (
              <div className={styles.activeBadge}>
                <span className={styles.activeDot} />
                Активен
              </div>
            )}
          </div>

          <div className={styles.card}>
            <h4 className={styles.cardTitle}>Загрузить существующий флоу</h4>
            <div className={styles.row}>
              <input className={controls.input} value={loadFlowId} onChange={(e) => setLoadFlowId(e.target.value)} placeholder="flowId" style={{ flex: 1, minWidth: 0 }} />
              <input className={controls.input} value={loadVersion} onChange={(e) => setLoadVersion(e.target.value)} placeholder="версия" style={{ width: 70 }} />
              <button className={controls.buttonSecondary} onClick={loadFlow}>
                Загрузить
              </button>
            </div>
          </div>

          {errors.length > 0 && (
            <div className={`${styles.card} ${styles.errorBox}`}>
              <h4 className={styles.cardTitle}>Ошибки валидации</h4>
              <ul>
                {errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </div>
          )}

          {status && <div className={styles.statusLine}>{status}</div>}

          <button className={controls.devToggle} onClick={() => setDevMode(!devMode)}>
            {devMode ? '▾' : '▸'} Режим разработчика
          </button>

          {devMode && (
            <div className={controls.devPanel}>
              <div className={styles.card}>
                <h4 className={styles.cardTitle}>Подключение</h4>
                {/* The API base is no longer editable here. Requests go to
                    this origin and Next forwards them, which is what keeps
                    the session cookie same-site; pointing the browser
                    somewhere else would silently stop the cookie being sent
                    and 401 the whole app. */}
                <input className={controls.input} value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="apiKey" style={{ width: '100%' }} />
                <input className={controls.input} value={botId} onChange={(e) => setBotId(e.target.value)} placeholder="botId" style={{ width: '100%' }} />
                <button className={controls.buttonSecondary} onClick={quickSetup}>
                  Быстрый старт (создать tenant+бота)
                </button>
              </div>

              <div className={styles.card}>
                <h4 className={styles.cardTitle}>Тест-режим</h4>
                <p className={styles.hint}>Ничего не пишет в БД — в CRM не появится.</p>
                <input className={controls.input} value={testUser} onChange={(e) => setTestUser(e.target.value)} placeholder="externalUserId" style={{ width: '100%' }} />
                <input className={controls.input} value={testMessage} onChange={(e) => setTestMessage(e.target.value)} placeholder="сообщение" style={{ width: '100%' }} />
                <button className={controls.buttonSecondary} onClick={runTest}>
                  Отправить тестовое сообщение
                </button>
              </div>

              <div className={styles.card}>
                <h4 className={styles.cardTitle}>Мок-вебхук (реальное сообщение)</h4>
                <p className={styles.hint}>Пишет в БД по-настоящему — появится в /crm.</p>
                <input className={controls.input} value={webhookUser} onChange={(e) => setWebhookUser(e.target.value)} placeholder="externalUserId" style={{ width: '100%' }} />
                <input className={controls.input} value={webhookMessage} onChange={(e) => setWebhookMessage(e.target.value)} placeholder="сообщение" style={{ width: '100%' }} />
                <button className={controls.buttonSecondary} onClick={sendWebhook}>
                  Отправить как реальный вебхук
                </button>
              </div>

              <div className={styles.card}>
                <h4 className={styles.cardTitle}>Дашборд</h4>
                <button className={controls.buttonSecondary} onClick={refreshDashboard}>
                  Обновить
                </button>
                <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap', color: 'var(--foreground-muted)' }}>{dashboard ? JSON.stringify(dashboard, null, 2) : '—'}</pre>
              </div>
            </div>
          )}
        </aside>
      </div>
      <TabBar current="/bot" />
    </div>
  );
}

import './approved-life-details.css';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import {
  Plus,
  Settings,
  Pause,
  Play,
  Trash2,
  ExternalLink,
  Search,
  ChevronLeft,
} from '../../components/icons';
import {
  CustomerConfirm,
  CustomerDialog,
  CustomerEmpty,
  CustomerError,
  CustomerSkeleton,
} from './components';
import { useCustomerQuery } from './hooks';
import { customerApi } from './api';
import { dateTimeLabel } from './helpers';
import {
  BellOff,
  ChevronRight,
  Clock3,
  CloudSun,
  Coins,
  FileText,
  Globe2,
  MessageCircle,
  Newspaper,
  Radio,
  Rocket,
  Trophy,
  Tv,
  Zap,
} from 'lucide-react';
import type { Customer } from './types';
import type {
  CustomerRadarData,
  RadarCatalogItem,
  RadarChoice,
  RadarInput,
  RadarInterest,
  RadarPreferences,
} from './radar-types';

const defaults: RadarPreferences = {
  enabled: false,
  time: '07:00',
  quietStart: '22:00',
  quietEnd: '07:00',
};
const message = (e: unknown) =>
  e instanceof Error ? e.message : 'Não foi possível concluir. Tente novamente.';
const deliveryLabel = (i: RadarInterest) =>
  i.delivery === 'matchday'
    ? `Só nos dias de jogo${i.notifyTime ? ` · às ${i.notifyTime}` : ''}`
    : i.delivery === 'before'
      ? 'Aviso antes do evento'
      : i.delivery === 'threshold'
        ? 'Alerta de valor'
        : 'No resumo diário';
const states: Record<string, string> = {
  pending: 'Agendado',
  leased: 'Em processamento',
  sending: 'Envio em andamento',
  sent: 'Enviado',
  unknown: 'Envio sem confirmação',
  cancelled: 'Cancelado',
  expired: 'Expirado',
};
export function CustomerRadar({
  customer,
  active,
  revision,
  onChanged,
}: {
  customer: Customer;
  active: boolean;
  revision: number;
  onChanged: (text: string) => void;
}) {
  const data = useCustomerQuery(
    'customer-radar-' + customer.accountId,
    (signal) => customerApi.radar(customer.accountId, signal),
    active,
    revision
  );
  const [adding, setAdding] = useState(false),
    [tab, setTab] = useState<'overview' | 'preferences' | 'history'>('overview'),
    [editing, setEditing] = useState<RadarInterest | null>(null),
    [deleting, setDeleting] = useState<RadarInterest | null>(null);
  const [prefs, setPrefs] = useState<RadarPreferences>(defaults),
    [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null),
    [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  const [clock, setClock] = useState(Date.now());
  const hasInterests = !!data.data?.interests.length;
  useEffect(() => {
    if (!active || !hasInterests) return;
    const t = setInterval(() => {
      if (document.visibilityState !== 'hidden') data.retry();
    }, 60000);
    return () => clearInterval(t);
  }, [active, hasInterests, data.retry]);
  useEffect(() => {
    if (active) {
      setClock(Date.now());
      const t = setInterval(() => setClock(Date.now()), 60000);
      return () => clearInterval(t);
    }
  }, [active]);
  useEffect(() => {
    if (data.data && !dirty) setPrefs(data.data.preferences);
  }, [data.data, dirty]);
  async function mutate(id: string, fn: () => Promise<unknown>, success: string) {
    if (lock.current) return;
    lock.current = true;
    setBusy(id);
    setError(null);
    try {
      await fn();
      setDeleting(null);
      onChanged(success);
      data.retry();
    } catch (e) {
      setError(message(e));
    } finally {
      lock.current = false;
      setBusy(null);
    }
  }
  const savePrefs = (e: FormEvent) => {
    e.preventDefault();
    void mutate(
      'preferences',
      async () => {
        await customerApi.radarPreferences(customer.accountId, prefs);
        setDirty(false);
      },
      prefs.enabled ? 'Preferências do Radar salvas.' : 'Envios do Radar desativados.'
    );
  };
  if (!data.data)
    return (
      <div className="approved-life-page">
        <header className="page-heading">
          <div>
            <div className="eyebrow">SEU OLHAR PARA O QUE IMPORTA</div>
            <h1>Astra Radar</h1>
          </div>
        </header>
        {data.error ? (
          <CustomerError error={data.error} onRetry={data.retry} />
        ) : (
          <CustomerSkeleton label="Abrindo seu Radar…" />
        )}
      </div>
    );
  const loaded = data.data;
  const chatLink = (text: string) => {
    if (!loaded.chatUrl) return undefined;
    const url = new URL(loaded.chatUrl);
    if (url.protocol !== 'https:' || url.hostname !== 'wa.me') return undefined;
    url.searchParams.set('text', text);
    return url.href;
  };
  const activeInterests = loaded.interests.filter((interest) => interest.active);
  const activeCount = activeInterests.length;
  const digestCount = activeInterests.filter((interest) => interest.delivery === 'digest').length;
  const timingLabel = !loaded.preferences.enabled
    ? 'Seu Radar está em pausa'
    : digestCount > 0
      ? 'Resumo às ' + loaded.preferences.time
      : activeCount > 0 && activeInterests.every((interest) => interest.delivery === 'matchday')
        ? 'Só nos dias de jogo'
        : activeCount > 0
          ? 'Avisos nos dias escolhidos'
          : 'Você escolhe o que acompanhar';
  const individualTimes = [
    ...new Set(
      activeInterests
        .filter((interest) => interest.delivery === 'matchday' && interest.notifyTime)
        .map((interest) => interest.notifyTime!)
    ),
  ];
  const preferredTime =
    digestCount > 0 || activeCount === 0
      ? loaded.preferences.time
      : individualTimes.length === 1
        ? individualTimes[0]!
        : 'No seu ritmo';
  const topicAppearance = {
    weather: { Icon: CloudSun, color: '#e6a24b' },
    ptax: { Icon: Coins, color: '#209b76' },
    currency: { Icon: Coins, color: '#209b76' },
    football: { Icon: Trophy, color: '#37886a' },
    news: { Icon: Newspaper, color: '#0061fd' },
    series: { Icon: Tv, color: '#997de0' },
    gazettes: { Icon: FileText, color: '#4f86bc' },
    energy: { Icon: Zap, color: '#d7a532' },
    releases: { Icon: Rocket, color: '#7a6cce' },
  };
  const snapshots = loaded.interests.filter((interest) => interest.snapshot);
  const pauseAll = () => {
    const nextPreferences = { ...loaded.preferences, enabled: !loaded.preferences.enabled };
    void mutate(
      'all',
      async () => {
        await customerApi.radarPreferences(customer.accountId, nextPreferences);
        setPrefs((current) => ({ ...current, enabled: nextPreferences.enabled }));
      },
      nextPreferences.enabled ? 'Radar ativado.' : 'Radar pausado.'
    );
  };
  return (
    <div className="approved-life-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">SEU OLHAR PARA O QUE IMPORTA</div>
          <h1>Astra Radar</h1>
          <p>O mundo se move. Acompanhe o que faz sentido para você.</p>
        </div>
        <button
          className="primary-button"
          type="button"
          disabled={!customer.access.canWrite}
          onClick={() => setAdding(true)}
        >
          <Plus size={17} />
          Acompanhar assunto
        </button>
      </div>
      <section className="life-radar-hero">
        <div className="life-radar-hero-copy">
          <div className="life-radar-label">
            <Radio size={17} />
            <span>UM RESUMO, DO SEU JEITO</span>
          </div>
          <h2>
            Bem informado.
            <br />
            Sem o excesso.
          </h2>
          <p>
            Escolha seus assuntos e organize suas preferências para receber o essencial pelo
            WhatsApp.
          </p>
          {chatLink('Quero configurar meu Radar') ? (
            <a
              className="life-white-button"
              href={chatLink('Quero configurar meu Radar')}
              target="_blank"
              rel="noopener noreferrer"
            >
              <MessageCircle size={17} />
              Configurar pelo WhatsApp
              <ChevronRight size={16} />
            </a>
          ) : (
            <button className="life-white-button" type="button" disabled>
              <MessageCircle size={17} />
              WhatsApp indisponível
            </button>
          )}
        </div>
        <div className="life-radar-preview">
          <div className="life-radar-preview-label">
            <Clock3 size={17} />
            SEU HORÁRIO PREFERIDO
          </div>
          <strong>{preferredTime}</strong>
          <span>{loaded.interests.length} assuntos selecionados</span>
          <p>
            {timingLabel}
            <br />
            Horários da sua conta.
          </p>
          <button type="button" onClick={() => setTab('preferences')}>
            Ajustar meu horário
            <ChevronRight size={16} />
          </button>
        </div>
      </section>
      <div className="life-radar-summary">
        <div>
          <span className="life-summary-icon">
            <Radio size={19} />
          </span>
          <div>
            <strong>{loaded.interests.length} assuntos</strong>
            <span>{activeCount} acompanhamentos ativos</span>
          </div>
        </div>
        <div>
          <span className="life-summary-icon">
            <Clock3 size={19} />
          </span>
          <div>
            <strong>{timingLabel}</strong>
            <span>Horário de {loaded.timeZone.replace('America/', '').replaceAll('_', ' ')}</span>
          </div>
        </div>
        <div>
          <span className="life-summary-icon">
            <BellOff size={19} />
          </span>
          <div>
            <strong>
              {loaded.preferences.quietStart} — {loaded.preferences.quietEnd}
            </strong>
            <span>Seu período de silêncio</span>
          </div>
        </div>
      </div>
      <div className="life-radar-tabs">
        <div className="segmented-control tabs" role="group" aria-label="Seções do Radar">
          {(
            [
              ['overview', 'Meus assuntos'],
              ['preferences', 'Preferências'],
              ['history', 'Histórico'],
            ] as const
          ).map(([key, label]) => (
            <button
              type="button"
              key={key}
              className={tab === key ? 'active' : ''}
              aria-pressed={tab === key}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="text-button"
          disabled={busy !== null || (!customer.access.canWrite && !loaded.preferences.enabled)}
          onClick={pauseAll}
        >
          {loaded.preferences.enabled ? <Pause size={15} /> : <Play size={15} />}
          {loaded.preferences.enabled ? 'Pausar todos' : 'Retomar todos'}
        </button>
      </div>
      {error && !deleting ? <CustomerError error={error} /> : null}
      {data.error ? <CustomerError error={data.error} onRetry={data.retry} /> : null}
      {tab === 'overview' ? (
        <>
          <div className="life-topic-grid">
            {loaded.interests.map((interest) => {
              const source = loaded.catalog.find((item) => item.id === interest.source),
                appearance = topicAppearance[interest.source] || { Icon: Globe2, color: '#0061fd' },
                Icon = appearance.Icon;
              const fresh = !!interest.snapshot && Date.parse(interest.snapshot.expiresAt) > clock,
                paused = !interest.active || !loaded.preferences.enabled;
              const status = paused
                ? 'Pausado'
                : interest.errorCode && !interest.snapshot
                  ? 'Fonte indisponível'
                  : fresh
                    ? 'Atualizado'
                    : interest.snapshot
                      ? 'Sem atualização recente'
                      : 'Aguardando atualização';
              return (
                <article
                  key={interest.id}
                  className="panel life-topic-card"
                  aria-label={interest.label}
                >
                  <div className="life-topic-top">
                    <span
                      className="life-app-icon"
                      style={{
                        color: appearance.color,
                        background: `color-mix(in srgb, ${appearance.color} 9%, transparent)`,
                      }}
                    >
                      <Icon size={25} />
                    </span>
                    <span className={`badge ${paused ? 'neutral' : 'success'}`}>{status}</span>
                  </div>
                  <h2>{interest.label}</h2>
                  <p>
                    {deliveryLabel(interest)}
                    {interest.delivery === 'threshold'
                      ? ' · ' +
                        {
                          above: 'acima de R$ ',
                          below: 'abaixo de R$ ',
                          at_or_above: 'igual ou acima de R$ ',
                          at_or_below: 'igual ou abaixo de R$ ',
                        }[interest.comparison ?? 'above'] +
                        interest.threshold
                      : ''}
                  </p>
                  <div className="life-topic-source">
                    <span className="life-dot" />
                    <span>
                      {source?.provider ||
                        interest.snapshot?.sourceLabel ||
                        'Fonte aguardando consulta'}
                    </span>
                  </div>
                  <div className="life-topic-footer">
                    <button
                      className="text-button"
                      type="button"
                      disabled={busy !== null || (!customer.access.canWrite && !interest.active)}
                      aria-label={(interest.active ? 'Pausar ' : 'Ativar ') + interest.label}
                      onClick={() =>
                        void mutate(
                          interest.id,
                          () =>
                            customerApi.radarChange(customer.accountId, interest.id, {
                              active: !interest.active,
                            }),
                          interest.active ? 'Acompanhamento pausado.' : 'Acompanhamento ativado.'
                        )
                      }
                    >
                      {interest.active ? <Pause size={15} /> : <Play size={15} />}
                      {interest.active ? 'Pausar' : 'Ativar'}
                    </button>
                    <div className="approved-radar-item-actions">
                      <button
                        className="icon-button"
                        type="button"
                        disabled={busy !== null || !customer.access.canWrite}
                        aria-label={'Editar ' + interest.label}
                        onClick={() => setEditing(interest)}
                      >
                        <Settings size={16} />
                      </button>
                      <button
                        className="icon-button"
                        type="button"
                        disabled={busy !== null}
                        aria-label={'Excluir ' + interest.label}
                        onClick={() => {
                          setError(null);
                          setDeleting(interest);
                        }}
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
            <button
              type="button"
              className="life-topic-add"
              disabled={!customer.access.canWrite}
              onClick={() => setAdding(true)}
            >
              <span>
                <Plus size={24} />
              </span>
              <strong>Seu próximo interesse</strong>
              <p>Descubra mais assuntos para acompanhar.</p>
            </button>
          </div>
          <section className="panel life-radar-updates">
            <div className="section-heading">
              <div>
                <h2>Últimas atualizações</h2>
                <p>Informação com contexto e origem.</p>
              </div>
              <span className="badge">
                {snapshots.length ? 'Fontes conectadas' : 'Aguardando consulta'}
              </span>
            </div>
            {snapshots.length ? (
              <div className="approved-radar-updates">
                {snapshots.map((interest) => {
                  const snapshot = interest.snapshot!;
                  return (
                    <article key={interest.id} className="approved-radar-update">
                      <div className="section-heading">
                        <h3>{interest.label}</h3>
                        <span className="badge">
                          {Date.parse(snapshot.expiresAt) > clock
                            ? 'Atualizado'
                            : 'Sem atualização recente'}
                        </span>
                      </div>
                      {snapshot.items.length ? (
                        snapshot.items.slice(0, 3).map((item) => (
                          <div key={item.id}>
                            <strong>{item.title}</strong>
                            {item.at ? (
                              <small>{dateTimeLabel(item.at, customer.timeZone)}</small>
                            ) : null}
                            {item.text ? <p>{item.text}</p> : null}
                            {interest.source !== 'football' && item.url?.startsWith('https://') ? (
                              <a
                                className="text-button"
                                href={item.url}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                Ver na fonte
                                <ExternalLink size={14} />
                              </a>
                            ) : null}
                          </div>
                        ))
                      ) : (
                        <p>
                          {interest.source === 'football'
                            ? 'Nenhuma partida prevista para os próximos dias.'
                            : 'Nenhuma nova informação para este acompanhamento.'}
                        </p>
                      )}
                      <details>
                        <summary>Fonte e atualização</summary>
                        <p>
                          {snapshot.sourceLabel} · Consultado em{' '}
                          {dateTimeLabel(snapshot.observedAt, customer.timeZone)}
                          {snapshot.sourceUpdatedAt
                            ? ' · Dados da fonte: ' +
                              (/^\d{4}-\d{2}-\d{2}$/.test(snapshot.sourceUpdatedAt)
                                ? snapshot.sourceUpdatedAt.split('-').reverse().join('/')
                                : dateTimeLabel(snapshot.sourceUpdatedAt, customer.timeZone))
                            : ''}
                          {snapshot.notice ? ' · ' + snapshot.notice : ''}
                        </p>
                        {interest.source === 'football' ? (
                          <span>Calendário previsto</span>
                        ) : snapshot.sourceUrl?.startsWith('https://') ? (
                          <a
                            className="text-button"
                            href={snapshot.sourceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            Consultar fonte
                            <ExternalLink size={14} />
                          </a>
                        ) : null}
                      </details>
                    </article>
                  );
                })}
              </div>
            ) : (
              <CustomerEmpty title="Suas atualizações aparecerão aqui">
                {loaded.interests.some((interest) => interest.errorCode)
                  ? 'Uma fonte está indisponível. Seus acompanhamentos permanecem salvos e o Astra tentará novamente.'
                  : 'Escolha seus assuntos. As informações serão mostradas com a origem e o horário da consulta.'}
              </CustomerEmpty>
            )}
          </section>
        </>
      ) : tab === 'preferences' ? (
        <section className="panel life-preferences-panel" aria-labelledby="radar-preferences">
          <div>
            <h2 id="radar-preferences">O essencial, na sua hora.</h2>
            <p>
              Ative ou pause todos os envios do Radar. O horário do resumo vale só para os assuntos
              marcados como resumo diário; os avisos individuais seguem seus próprios horários. Você
              também pode ajustar pelo WhatsApp.
            </p>
          </div>
          <form onSubmit={savePrefs}>
            <label className="life-check-row">
              <input
                type="checkbox"
                checked={prefs.enabled}
                disabled={busy !== null || (!customer.access.canWrite && !prefs.enabled)}
                onChange={(e) => {
                  setPrefs({ ...prefs, enabled: e.target.checked });
                  setDirty(true);
                }}
              />
              <span>
                <strong>Receber todos os envios do Radar</strong>
                <small>Ao desativar, você pausa resumos e avisos individuais.</small>
              </span>
            </label>
            <label className="field">
              Horário do resumo
              <input
                type="time"
                value={prefs.time}
                required
                disabled={!customer.access.canWrite || busy !== null}
                onChange={(e) => {
                  setPrefs({ ...prefs, time: e.target.value });
                  setDirty(true);
                }}
              />
            </label>
            <div className="form-grid">
              <label className="field">
                Silêncio a partir de
                <input
                  type="time"
                  value={prefs.quietStart}
                  required
                  disabled={!customer.access.canWrite || busy !== null}
                  onChange={(e) => {
                    setPrefs({ ...prefs, quietStart: e.target.value });
                    setDirty(true);
                  }}
                />
              </label>
              <label className="field">
                Voltar a receber às
                <input
                  type="time"
                  value={prefs.quietEnd}
                  required
                  disabled={!customer.access.canWrite || busy !== null}
                  onChange={(e) => {
                    setPrefs({ ...prefs, quietEnd: e.target.value });
                    setDirty(true);
                  }}
                />
              </label>
            </div>
            <div className="approved-radar-settings-footer">
              <span>
                O período de silêncio vale para todos os envios. Horários em{' '}
                {loaded.timeZone.replaceAll('_', ' ')}. Alertas vencidos não são enviados depois.
              </span>
              <button className="primary-button" disabled={!dirty || busy !== null} type="submit">
                {busy === 'preferences' ? 'Salvando…' : 'Salvar preferências'}
              </button>
            </div>
          </form>
        </section>
      ) : (
        <section className="panel life-preferences-panel">
          <div className="section-heading">
            <div>
              <h2>Histórico de avisos</h2>
              <p>Envios, cancelamentos e alertas que perderam a validade.</p>
            </div>
            <Clock3 size={22} />
          </div>
          {loaded.history.length ? (
            <div className="approved-radar-history">
              {loaded.history.map((row) => (
                <div key={row.id}>
                  <span>
                    <strong>{row.label || 'Resumo do Radar'}</strong>
                    <small>{dateTimeLabel(row.sent_at ?? row.created_at, customer.timeZone)}</small>
                  </span>
                  <span className="badge">{states[row.status] || 'Em processamento'}</span>
                </div>
              ))}
            </div>
          ) : (
            <CustomerEmpty title="Seu histórico começa aqui">
              Seus avisos aparecem aqui quando forem agendados.
            </CustomerEmpty>
          )}
        </section>
      )}
      {adding || editing ? (
        <RadarForm
          key={editing?.id ?? 'new'}
          customer={customer}
          data={loaded}
          editing={editing}
          onClose={() => {
            setAdding(false);
            setEditing(null);
          }}
          onSaved={() => {
            setAdding(false);
            setEditing(null);
            data.retry();
            onChanged(editing ? 'Acompanhamento atualizado.' : 'Assunto adicionado ao seu Radar.');
          }}
        />
      ) : null}
      {deleting ? (
        <CustomerConfirm
          title="Excluir acompanhamento?"
          action="Excluir acompanhamento"
          busy={busy !== null}
          error={error}
          onClose={() => setDeleting(null)}
          onConfirm={() =>
            void mutate(
              'delete',
              () => customerApi.radarRemove(customer.accountId, deleting.id),
              'Acompanhamento excluído.'
            )
          }
        >
          Você deixará de acompanhar {deleting.label}. Os avisos pendentes desse assunto serão
          cancelados.
        </CustomerConfirm>
      ) : null}
    </div>
  );
}

function RadarForm({
  customer,
  data,
  editing,
  onClose,
  onSaved,
}: {
  customer: Customer;
  data: CustomerRadarData;
  editing: RadarInterest | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const id = useId(),
    lock = useRef(false),
    searchController = useRef<AbortController | null>(null),
    seq = useRef(0);
  const [source, setSource] = useState<RadarCatalogItem | undefined>(() =>
    data.catalog.find((s) => s.id === editing?.source)
  );
  const [q, setQ] = useState(''),
    [choices, setChoices] = useState<RadarChoice[]>([]),
    [choice, setChoice] = useState<RadarChoice | null>(null);
  const [searched, setSearched] = useState(false),
    [busy, setBusy] = useState(false),
    [searching, setSearching] = useState(false),
    [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState<RadarInput>(() =>
    editing
      ? {
          source: editing.source,
          target: editing.target,
          query: editing.query,
          delivery: editing.delivery,
          notifyTime: editing.notifyTime,
          threshold: editing.threshold,
          comparison: editing.comparison,
          leadMinutes: editing.leadMinutes,
        }
      : { source: 'weather', target: '', delivery: 'digest', leadMinutes: 60 }
  );
  useEffect(
    () => () => {
      seq.current++;
      searchController.current?.abort();
    },
    []
  );
  const pickSource = (s: RadarCatalogItem) => {
    seq.current++;
    searchController.current?.abort();
    setSearching(false);
    setSource(s);
    setChoices([]);
    setChoice(null);
    setSearched(false);
    setQ('');
    setError(null);
    setInput({
      source: s.id,
      target:
        s.id === 'energy' ? 'bandeira-tarifaria' : ['currency', 'ptax'].includes(s.id) ? 'USD' : '',
      delivery: s.id === 'football' ? 'matchday' : 'digest',
      leadMinutes: 60,
    });
  };
  async function search(e: FormEvent) {
    e.preventDefault();
    if (!source || searching || q.trim().length < 3) return;
    const n = ++seq.current;
    searchController.current?.abort();
    const c = new AbortController();
    searchController.current = c;
    setSearching(true);
    setError(null);
    setChoice(null);
    try {
      const result = await customerApi.radarSearch(customer.accountId, source.id, q, c.signal);
      if (n === seq.current) {
        setChoices(result.choices);
        setSearched(true);
      }
    } catch (e) {
      if (!c.signal.aborted && n === seq.current) setError(message(e));
    } finally {
      if (n === seq.current) setSearching(false);
    }
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    if (lock.current || !source || !source.available) return;
    if (source.needsSearch && !editing && !choice) {
      setError('Selecione um resultado da busca.');
      return;
    }
    if (
      input.delivery === 'matchday' &&
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.notifyTime ?? '')
    ) {
      setError('Escolha o horário do aviso no dia do jogo.');
      return;
    }
    lock.current = true;
    setBusy(true);
    setError(null);
    const { notifyTime, ...baseInput } = input;
    try {
      if (editing)
        await customerApi.radarChange(customer.accountId, editing.id, {
          delivery: input.delivery,
          leadMinutes: input.leadMinutes,
          ...(input.delivery === 'matchday' ? { notifyTime } : {}),
          ...(input.delivery === 'threshold'
            ? { threshold: input.threshold, comparison: input.comparison }
            : {}),
        });
      else
        await customerApi.radarCreate(customer.accountId, {
          ...baseInput,
          target: choice?.id ?? input.target,
          ...(input.delivery === 'matchday' ? { notifyTime } : {}),
          ...(input.delivery === 'threshold' ? { comparison: input.comparison ?? 'above' } : {}),
        });
      onSaved();
    } catch (e) {
      setError(message(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <CustomerDialog
      title={
        editing
          ? 'Editar acompanhamento'
          : source
            ? 'Acompanhar ' + source.name.toLowerCase()
            : 'O que você quer acompanhar?'
      }
      busy={busy}
      onClose={onClose}
      footer={
        source ? (
          <>
            <button className="secondary-button" type="button" disabled={busy} onClick={onClose}>
              Cancelar
            </button>
            <button
              className="primary-button"
              type="submit"
              form={id}
              disabled={busy || searching || !source.available}
            >
              {busy ? 'Salvando…' : editing ? 'Salvar alterações' : 'Adicionar ao Radar'}
            </button>
          </>
        ) : undefined
      }
    >
      {!source ? (
        <div className="ac-radar-catalog">
          {data.catalog.map((s) => (
            <button
              type="button"
              key={s.id}
              className="ac-radar-source"
              disabled={!s.available}
              onClick={() => pickSource(s)}
            >
              <strong>{s.name}</strong>
              <span>{s.description}</span>
              <small>{s.available ? s.provider : s.disabledReason}</small>
            </button>
          ))}
        </div>
      ) : (
        <>
          {!editing ? (
            <button
              className="ac-text-button ac-radar-back"
              type="button"
              onClick={() => {
                seq.current++;
                searchController.current?.abort();
                setSource(undefined);
                setError(null);
              }}
            >
              <ChevronLeft aria-hidden="true" />
              Trocar assunto
            </button>
          ) : null}
          <p className="ac-body-copy">{source.description}</p>
          {source.needsSearch && !editing ? (
            <form className="ac-radar-search" onSubmit={search}>
              <label htmlFor={id + '-search'}>{source.hint}</label>
              <div>
                <input
                  id={id + '-search'}
                  value={q}
                  maxLength={100}
                  minLength={3}
                  required
                  placeholder={source.hint}
                  onChange={(e) => {
                    seq.current++;
                    searchController.current?.abort();
                    setSearching(false);
                    setChoice(null);
                    setChoices([]);
                    setSearched(false);
                    setQ(e.target.value);
                  }}
                />
                <button
                  className="secondary-button"
                  type="submit"
                  disabled={searching || q.trim().length < 3}
                >
                  <Search aria-hidden="true" />
                  {searching ? 'Buscando…' : 'Buscar'}
                </button>
              </div>
              {choices.length ? (
                <fieldset className="ac-radar-choices">
                  <legend>Selecione uma opção</legend>
                  {choices.map((c) => (
                    <label key={c.id}>
                      <input
                        type="radio"
                        name={id + '-choice'}
                        checked={choice?.id === c.id}
                        onChange={() => setChoice(c)}
                      />
                      <span>
                        {c.label}
                        {c.description ? <small>{c.description}</small> : null}
                      </span>
                    </label>
                  ))}
                </fieldset>
              ) : searched ? (
                <p>Nenhum resultado encontrado. Tente informar mais detalhes.</p>
              ) : null}
            </form>
          ) : null}
          <form id={id} className="ac-form ac-radar-form" onSubmit={save}>
            {editing ? (
              <p>
                <strong>{editing.label}</strong>
              </p>
            ) : !source.needsSearch && source.id !== 'energy' ? (
              <label className="field">
                {source.hint}
                {['currency', 'ptax'].includes(source.id) ? (
                  <select
                    value={input.target}
                    onChange={(e) => setInput({ ...input, target: e.target.value })}
                  >
                    {['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'ARS', 'CNY'].map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    required
                    maxLength={100}
                    value={input.target}
                    placeholder={source.hint}
                    onChange={(e) => setInput({ ...input, target: e.target.value })}
                  />
                )}
              </label>
            ) : null}
            {source.id === 'gazettes' && !editing ? (
              <label className="field">
                Assunto que deseja encontrar
                <input
                  required
                  minLength={2}
                  maxLength={100}
                  placeholder="Ex.: concurso ou educação"
                  value={input.query ?? ''}
                  onChange={(e) => setInput({ ...input, query: e.target.value })}
                />
              </label>
            ) : null}
            <label className="field">
              Como quer receber?
              <select
                value={input.delivery}
                onChange={(e) =>
                  setInput({ ...input, delivery: e.target.value as RadarInput['delivery'] })
                }
              >
                {source.id === 'football' ? (
                  <option value="matchday">Só nos dias de jogo</option>
                ) : null}
                <option value="digest">Junto no resumo diário</option>
                {source.id === 'series' ? <option value="before">Antes do evento</option> : null}
                {['currency', 'ptax'].includes(source.id) ? (
                  <option value="threshold">Quando passar de um valor</option>
                ) : null}
              </select>
            </label>
            {input.delivery === 'matchday' ? (
              <label className="field">
                Horário do aviso no dia do jogo
                <input
                  type="time"
                  required
                  value={input.notifyTime ?? ''}
                  onChange={(e) => setInput({ ...input, notifyTime: e.target.value })}
                />
              </label>
            ) : null}
            {input.delivery === 'before' ? (
              <label className="field">
                Antecedência
                <select
                  value={input.leadMinutes}
                  onChange={(e) => setInput({ ...input, leadMinutes: Number(e.target.value) })}
                >
                  <option value={15}>15 minutos</option>
                  <option value={30}>30 minutos</option>
                  <option value={60}>1 hora</option>
                  <option value={120}>2 horas</option>
                  <option value={1440}>1 dia</option>
                </select>
              </label>
            ) : null}
            {input.delivery === 'threshold' ? (
              <div className="ac-radar-threshold">
                <label className="field">
                  Condição
                  <select
                    value={input.comparison ?? 'above'}
                    onChange={(e) =>
                      setInput({
                        ...input,
                        comparison: e.target.value as NonNullable<typeof input.comparison>,
                      })
                    }
                  >
                    <option value="above">Acima de</option>
                    <option value="below">Abaixo de</option>
                    <option value="at_or_above">Igual ou acima de</option>
                    <option value="at_or_below">Igual ou abaixo de</option>
                  </select>
                </label>
                <label className="field">
                  Valor em reais
                  <input
                    type="text"
                    inputMode="decimal"
                    required
                    pattern="[0-9]+([.,][0-9]{1,6})?"
                    maxLength={15}
                    placeholder="Ex.: 5,50"
                    value={input.threshold ?? ''}
                    onChange={(e) => setInput({ ...input, threshold: e.target.value })}
                  />
                </label>
              </div>
            ) : null}
            <p className="ac-radar-source-note">
              {source.provider} · {source.license}.{' '}
              {source.id === 'football'
                ? input.delivery === 'matchday'
                  ? 'Você recebe no horário escolhido, só nos dias com jogo previsto. A data pode mudar e o horário de início pode não estar confirmado. Sem placar ao vivo.'
                  : 'Jogos previstos no seu resumo diário. A data pode mudar e o horário de início pode não estar confirmado. Sem placar ao vivo.'
                : source.id === 'series'
                  ? 'A data da fonte não confirma estreia no Brasil.'
                  : source.id === 'ptax' || source.id === 'currency'
                    ? 'Taxa de referência, sem cotação de mercado em tempo real.'
                    : ''}
            </p>
          </form>
        </>
      )}
      {error ? <CustomerError error={error} /> : null}
    </CustomerDialog>
  );
}

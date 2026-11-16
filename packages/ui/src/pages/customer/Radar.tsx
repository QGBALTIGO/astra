import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import {
  Bell,
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
import type { Customer } from './types';
import type {
  CustomerRadarData,
  RadarCatalogItem,
  RadarChoice,
  RadarInput,
  RadarInterest,
  RadarPreferences,
} from './radar-types';
import './radar.css';

const defaults: RadarPreferences = {
  enabled: false,
  time: '07:00',
  quietStart: '22:00',
  quietEnd: '07:00',
};
const message = (e: unknown) =>
  e instanceof Error ? e.message : 'Não foi possível concluir. Tente novamente.';
const deliveryLabel = (i: RadarInterest) =>
  i.delivery === 'before'
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
    [editing, setEditing] = useState<RadarInterest | null>(null),
    [deleting, setDeleting] = useState<RadarInterest | null>(null);
  const [prefs, setPrefs] = useState<RadarPreferences>(defaults),
    [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null),
    [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  const [clock, setClock] = useState(Date.now());
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
      <div className="ac-page">
        <header className="ac-page-heading">
          <div>
            <p className="ac-eyebrow">SEUS INTERESSES, NO SEU RITMO</p>
            <h1>Radar</h1>
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
  return (
    <div className="ac-page ac-radar">
      <header className="ac-page-heading">
        <div>
          <p className="ac-eyebrow">SEUS INTERESSES, NO SEU RITMO</p>
          <h1>Radar</h1>
          <p>Acompanhe só o que importa para você, com fontes e atualizações visíveis.</p>
        </div>
        <button
          type="button"
          className="ac-button"
          disabled={!customer.access.canWrite}
          onClick={() => setAdding(true)}
        >
          <Plus aria-hidden="true" />
          Adicionar assunto
        </button>
      </header>
      <section className="ac-card ac-radar-settings" aria-labelledby="radar-preferences">
        <div>
          <h2 id="radar-preferences">Seu resumo no WhatsApp</h2>
          <p>
            Uma mensagem reúne os assuntos do resumo. Jogos e alertas de valor seguem a regra
            escolhida.
          </p>
        </div>
        <form onSubmit={savePrefs}>
          <label className="ac-radar-optin">
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
              <strong>Receber meu Radar no WhatsApp</strong>
              <small>Você pode desativar quando quiser. Nada é enviado sem sua ativação.</small>
            </span>
          </label>
          <div className="ac-radar-times">
            <label>
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
            <label>
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
            <label>
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
          <div className="ac-radar-settings-footer">
            <span>
              Horários em {loaded.timeZone.replaceAll('_', ' ')}. Alertas vencidos não são enviados
              depois.
            </span>
            <button
              className="ac-button ac-button--secondary"
              disabled={!dirty || busy !== null}
              type="submit"
            >
              {busy === 'preferences' ? 'Salvando…' : 'Salvar preferências'}
            </button>
          </div>
        </form>
      </section>
      {error && !deleting ? <CustomerError error={error} /> : null}
      {data.error ? <CustomerError error={data.error} onRetry={data.retry} /> : null}
      <section className="ac-card ac-card--flush" aria-labelledby="radar-following">
        <div className="ac-radar-section-head">
          <div>
            <h2 id="radar-following">Meus acompanhamentos</h2>
            <p>
              {loaded.interests.filter((i) => i.active).length} ativos · você escolhe quais manter.
            </p>
          </div>
          <Bell aria-hidden="true" />
        </div>
        {!loaded.interests.length ? (
          <CustomerEmpty
            title="Seu Radar começa pelos seus interesses"
            action={
              customer.access.canWrite ? (
                <button
                  className="ac-button ac-button--secondary"
                  type="button"
                  onClick={() => setAdding(true)}
                >
                  Explorar assuntos
                </button>
              ) : undefined
            }
          >
            Escolha uma cidade, um time, uma série ou outro assunto para acompanhar.
          </CustomerEmpty>
        ) : (
          <div className="ac-radar-list">
            {loaded.interests.map((i) => {
              const source = loaded.catalog.find((s) => s.id === i.source),
                fresh = !!i.snapshot && Date.parse(i.snapshot.expiresAt) > clock;
              const status = !i.active
                ? 'Pausado'
                : !i.snapshot
                  ? i.errorCode
                    ? 'Fonte indisponível'
                    : 'Aguardando primeira atualização'
                  : fresh
                    ? 'Atualizado'
                    : 'Sem atualização recente';
              return (
                <article key={i.id} className="ac-radar-follow" aria-label={i.label}>
                  <div className="ac-radar-follow-heading">
                    <div>
                      <span className="ac-radar-category">{source?.name}</span>
                      <h3>{i.label}</h3>
                      <p>
                        {deliveryLabel(i)}
                        {i.delivery === 'threshold'
                          ? ' · ' +
                            (i.comparison === 'above' ? 'acima de R$ ' : 'abaixo de R$ ') +
                            i.threshold
                          : ''}
                      </p>
                    </div>
                    <span className={'ac-radar-status' + (i.active && fresh ? ' is-current' : '')}>
                      {status}
                    </span>
                  </div>
                  {i.snapshot ? (
                    <div className="ac-radar-preview">
                      {i.snapshot.items.slice(0, 3).map((item) => (
                        <div key={item.id} className="ac-radar-preview-item">
                          <strong>{item.title}</strong>
                          {item.at ? (
                            <span>{dateTimeLabel(item.at, customer.timeZone)}</span>
                          ) : null}
                          {item.text ? <p>{item.text}</p> : null}
                          {item.url?.startsWith('https://') ? (
                            <a href={item.url} target="_blank" rel="noopener noreferrer">
                              Ver na fonte <ExternalLink aria-hidden="true" />
                            </a>
                          ) : null}
                        </div>
                      ))}
                      {!i.snapshot.items.length ? (
                        <p>Nenhuma publicação encontrada no período consultado.</p>
                      ) : null}
                      <small>
                        Consultado em {dateTimeLabel(i.snapshot.observedAt, customer.timeZone)}
                        {i.snapshot.sourceUpdatedAt
                          ? ' · Dados da fonte: ' +
                            (/^\d{4}-\d{2}-\d{2}$/.test(i.snapshot.sourceUpdatedAt)
                              ? i.snapshot.sourceUpdatedAt.split('-').reverse().join('/')
                              : dateTimeLabel(i.snapshot.sourceUpdatedAt, customer.timeZone))
                          : ''}
                        {i.snapshot.notice ? ' · ' + i.snapshot.notice : ''}
                      </small>
                    </div>
                  ) : (
                    <p className="ac-radar-wait">
                      {i.errorCode
                        ? 'Não foi possível consultar esta fonte agora. O Astra tentará novamente.'
                        : 'A primeira consulta está agendada. Você pode continuar usando o Astra.'}
                    </p>
                  )}
                  <div className="ac-radar-follow-footer">
                    <a href={source?.url} target="_blank" rel="noopener noreferrer">
                      {source?.provider}
                      <ExternalLink aria-hidden="true" />
                    </a>
                    <div>
                      <button
                        className="ac-text-button"
                        type="button"
                        disabled={busy !== null || (!customer.access.canWrite && !i.active)}
                        onClick={() =>
                          void mutate(
                            i.id,
                            () =>
                              customerApi.radarChange(customer.accountId, i.id, {
                                active: !i.active,
                              }),
                            i.active ? 'Acompanhamento pausado.' : 'Acompanhamento ativado.'
                          )
                        }
                        aria-label={(i.active ? 'Pausar ' : 'Ativar ') + i.label}
                      >
                        {i.active ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
                        {i.active ? 'Pausar' : 'Ativar'}
                      </button>
                      <button
                        className="ac-icon-button"
                        type="button"
                        disabled={busy !== null || !customer.access.canWrite}
                        aria-label={'Editar ' + i.label}
                        onClick={() => setEditing(i)}
                      >
                        <Settings aria-hidden="true" />
                      </button>
                      <button
                        className="ac-icon-button"
                        type="button"
                        disabled={busy !== null}
                        aria-label={'Excluir ' + i.label}
                        onClick={() => {
                          setError(null);
                          setDeleting(i);
                        }}
                      >
                        <Trash2 aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
      <section className="ac-card ac-card--flush" aria-labelledby="radar-history">
        <div className="ac-radar-section-head">
          <div>
            <h2 id="radar-history">Histórico de avisos</h2>
            <p>Envios, cancelamentos e alertas que perderam a validade.</p>
          </div>
        </div>
        {loaded.history.length ? (
          <ul className="ac-radar-history">
            {loaded.history.map((row) => (
              <li key={row.id}>
                <div>
                  <strong>{row.label || 'Resumo do Radar'}</strong>
                  <span>{dateTimeLabel(row.sent_at ?? row.created_at, customer.timeZone)}</span>
                </div>
                <span>{states[row.status] ?? 'Em processamento'}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="ac-radar-wait">Seus avisos aparecem aqui quando forem agendados.</p>
        )}
      </section>
      <p className="ac-radar-footnote">
        Fontes gratuitas têm cobertura e frequência próprias. Cotações são referências, previsões
        são estimativas e informações podem chegar com atraso.
      </p>
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
      delivery: 'digest',
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
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      if (editing)
        await customerApi.radarChange(customer.accountId, editing.id, {
          delivery: input.delivery,
          leadMinutes: input.leadMinutes,
          ...(input.delivery === 'threshold'
            ? { threshold: input.threshold, comparison: input.comparison }
            : {}),
        });
      else
        await customerApi.radarCreate(customer.accountId, {
          ...input,
          target: choice?.id ?? input.target,
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
            <button
              className="ac-button ac-button--secondary"
              type="button"
              disabled={busy}
              onClick={onClose}
            >
              Cancelar
            </button>
            <button
              className="ac-button"
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
                  className="ac-button ac-button--secondary"
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
              <label>
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
              <label>
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
            <label>
              Como quer receber?
              <select
                value={input.delivery}
                onChange={(e) =>
                  setInput({ ...input, delivery: e.target.value as RadarInput['delivery'] })
                }
              >
                <option value="digest">Junto no resumo diário</option>
                {['football', 'series'].includes(source.id) ? (
                  <option value="before">Antes do evento</option>
                ) : null}
                {['currency', 'ptax'].includes(source.id) ? (
                  <option value="threshold">Quando passar de um valor</option>
                ) : null}
              </select>
            </label>
            {input.delivery === 'before' ? (
              <label>
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
                <label>
                  Condição
                  <select
                    value={input.comparison ?? 'above'}
                    onChange={(e) =>
                      setInput({ ...input, comparison: e.target.value as 'above' | 'below' })
                    }
                  >
                    <option value="above">Acima de</option>
                    <option value="below">Abaixo de</option>
                  </select>
                </label>
                <label>
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
                ? 'Somente Brasileirão Série A; horários e placares podem chegar com atraso.'
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

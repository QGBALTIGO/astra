import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ArrowDownLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  Clock3,
  Copy,
  ExternalLink,
  Gift,
  Link2,
  MessageCircle,
  Share2,
  ShieldCheck,
  Sparkles,
  UsersRound,
  Wallet,
} from 'lucide-react';
import type { Customer } from './types';
import { useCustomerQuery } from './hooks';
import { referralsApi } from './referrals-api';
import { money as currency } from './helpers';
const dateLabel = (value: string) =>
  new Date(value).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' });
import { Badge, Empty, Modal, PageHeading, SectionTabs } from './approved-profile-referral-ui';
import {
  campaign,
  referralSteps,
  referralFaqs,
  referralRules,
  statusLabels,
  type ReferralRecord,
  type ReferralStatus,
} from './approved-referral-policy';
import { CustomerError, CustomerSkeleton } from './components';
import './approved-referrals.css';

type ReferralTab = 'invitations' | 'how' | 'rules';
type ReferralDialog = 'copy' | 'payout' | 'help' | 'pix' | null;
type ReferralFilter = 'all' | 'progress' | 'rewarded' | 'ineligible';
const tabs = [
  { id: 'invitations' as const, label: 'Minhas indicações' },
  { id: 'how' as const, label: 'Como funciona' },
  { id: 'rules' as const, label: 'Regras' },
];
const statusDescriptions: Record<ReferralStatus, string> = {
  trial: 'Seu convite está conhecendo o Astra.',
  awaiting_payment: 'Falta concluir uma assinatura elegível.',
  validating:
    'Acompanhe a validação da assinatura ou a solicitação de Pix pelo status da indicação.',
  available: 'Assinatura validada. Sua recompensa está aprovada e pode ser solicitada por Pix.',
  paid: 'A equipe confirmou a realização do pagamento por Pix.',
  ineligible: 'As condições desta indicação não foram concluídas.',
};
const stepIcons = { link: Link2, whatsapp: MessageCircle, sparkles: Sparkles, check: ShieldCheck };
const statusIcon = (status: ReferralStatus) =>
  status === 'paid'
    ? CheckCircle2
    : status === 'available'
      ? Gift
      : status === 'validating'
        ? Clock3
        : status === 'ineligible'
          ? CircleHelp
          : UsersRound;
const statusTone = (status: ReferralStatus) =>
  status === 'available' || status === 'paid'
    ? 'success'
    : status === 'validating'
      ? 'warning'
      : 'neutral';

export function CustomerReferrals({
  customer,
  active,
  revision,
  notify,
}: {
  customer: Customer;
  active: boolean;
  revision: number;
  notify: (message: string, error?: boolean) => void;
}) {
  const p = { data: { name: customer.displayName }, hidden: customer.hideAmounts, notify };
  const [tab, setTab] = useState<ReferralTab>('invitations');
  const [filter, setFilter] = useState<ReferralFilter>('all');
  const [page, setPage] = useState(1),
    [localRevision, setLocalRevision] = useState(0);
  const query = useCustomerQuery(
    `referrals:${page}:${filter}`,
    (signal) => referralsApi.dashboard(customer.accountId, signal, page, filter),
    active,
    revision + localRevision
  );
  const data = query.data;
  const records: ReferralRecord[] = (data?.records ?? []).map((record) => ({
    ...record,
    source: record,
    status:
      record.status === 'approved'
        ? 'available'
        : record.status === 'paid'
          ? 'paid'
          : record.status === 'rejected'
            ? 'ineligible'
            : 'validating',
    reason: record.note || undefined,
  }));
  const [dialog, setDialog] = useState<ReferralDialog>(null);
  const [selected, setSelected] = useState<ReferralRecord | null>(null);
  const [payoutRecord, setPayoutRecord] = useState<ReferralRecord | null>(null),
    [pixKey, setPixKey] = useState(''),
    [payoutError, setPayoutError] = useState('');
  const payoutLock = useRef(false);
  const [busy, setBusy] = useState<'copy' | 'share' | 'pix' | null>(null),
    [copied, setCopied] = useState(false);
  const content = useRef<HTMLDivElement>(null),
    copyInput = useRef<HTMLInputElement>(null);
  const link = data?.link ?? '';
  const firstName = customer.displayName.trim().split(' ')[0] || 'você';
  const available = data?.available ?? 0,
    paid = data?.paid ?? 0,
    validating = data?.awaitingValidation ?? 0,
    rewarded = data?.rewardedThisCycle ?? 0,
    inProgress = validating;
  const shown = records;
  async function submitPayout(event: FormEvent) {
    event.preventDefault();
    if (payoutLock.current || !payoutRecord || !customer.access.canWrite) return;
    payoutLock.current = true;
    setBusy('pix');
    setPayoutError('');
    try {
      await referralsApi.payout(customer.accountId, payoutRecord.id, pixKey.trim());
      setDialog(null);
      setPayoutRecord(null);
      setPixKey('');
      setLocalRevision((value) => value + 1);
      notify('Solicitação de Pix registrada. Acompanhe o andamento pelo histórico.');
    } catch (error) {
      setPayoutError(error instanceof Error ? error.message : 'Não foi possível solicitar o Pix.');
    } finally {
      payoutLock.current = false;
      setBusy(null);
    }
  }
  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 2800);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  async function writeLink() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(link);
      setCopied(true);
      return true;
    } catch {
      setDialog('copy');
      return false;
    }
  }

  async function copyLink() {
    if (busy) return;
    setBusy('copy');
    const success = await writeLink();
    if (success) p.notify('Seu link de indicação foi copiado.');
    setBusy(null);
  }

  async function shareLink() {
    if (busy) return;
    setBusy('share');
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Um convite para conhecer o Astra',
          text: 'Um pouco mais de clareza para o dinheiro, a agenda e os planos. Conheça o Astra pelo meu convite:',
          url: link,
        });
      } catch (error) {
        if (!(
          error &&
          typeof error === 'object' &&
          'name' in error &&
          error.name === 'AbortError'
        )) {
          const success = await writeLink();
          if (success) p.notify('Compartilhamento indisponível. Seu link foi copiado.');
        }
      }
    } else {
      const success = await writeLink();
      if (success) p.notify('Link copiado. Cole na conversa que você escolher.');
    }
    setBusy(null);
  }

  function openTab(value: ReferralTab) {
    setTab(value);
    window.requestAnimationFrame(() =>
      content.current?.scrollIntoView({
        block: 'start',
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      })
    );
  }

  if (!data)
    return (
      <div className="referral-page">
        <PageHeading
          eyebrow="ASTRA CONVIDA"
          title="Indique o Astra"
          description="Mais clareza para quem você gosta. Novas possibilidades para você."
        />
        {query.error ? (
          <CustomerError error={query.error} onRetry={query.retry} />
        ) : (
          <CustomerSkeleton label="Carregando suas indicações…" />
        )}
      </div>
    );
  return (
    <div className="referral-page">
      <PageHeading
        eyebrow="ASTRA CONVIDA"
        title="Indique o Astra"
        description="Mais clareza para quem você gosta. Novas possibilidades para você."
        action={
          <button className="secondary-button" onClick={() => openTab('rules')}>
            <ShieldCheck size={16} />
            Regras da campanha
          </button>
        }
      />

      {query.error && <CustomerError error={query.error} onRetry={query.retry} />}

      <div className="referral-header-grid">
        <section className="referral-hero">
          <div className="referral-hero-kicker">
            <span>
              <Gift size={20} />
            </span>
            UMA BOA INDICAÇÃO TEM VALOR
          </div>
          <h2>
            Compartilhe um pouco
            <br className="referral-desktop-break" /> de clareza.
          </h2>
          <p>
            Convide alguém para organizar o dinheiro, a agenda e os planos com o Astra pelo
            WhatsApp.
          </p>
          <div className="referral-reward-range">
            <span>Entre</span>
            <strong>
              R$ {campaign.minReward}
              <i>e</i>R$ {campaign.maxReward}
            </strong>
            <span>por indicação elegível</span>
          </div>
          <div className="referral-hero-footer">
            <span>
              <CheckCircle2 size={16} />
              Até {campaign.rewardLimit} recompensas por mês
            </span>
            <button className="referral-hero-copy" onClick={copyLink} disabled={!!busy}>
              {copied ? <Check size={16} /> : <Copy size={16} />}{' '}
              {copied ? 'Convite copiado' : 'Copiar convite'}
            </button>
          </div>
        </section>

        <section className="panel referral-link-card">
          <div className="referral-link-heading">
            <span className="referral-person-avatar">{firstName.slice(0, 1).toUpperCase()}</span>
            <div>
              <span>SEU CONVITE PESSOAL</span>
              <h2>Um convite de {firstName}.</h2>
            </div>
          </div>
          <p>O começo de uma rotina mais organizada pode ser uma mensagem sua.</p>
          <label className="field referral-link-label">
            Seu link de indicação
            <div className="referral-link-input">
              <Link2 size={17} />
              <input
                aria-label="Link de indicação"
                value={link}
                readOnly
                onFocus={(event) => event.currentTarget.select()}
                title={link}
              />
            </div>
          </label>
          <div className="referral-copy-actions">
            <button className="primary-button" disabled={!!busy} onClick={copyLink}>
              {copied ? <Check size={17} /> : <Copy size={17} />}{' '}
              {copied ? 'Link copiado' : busy === 'copy' ? 'Copiando…' : 'Copiar meu link'}
            </button>
            <button className="secondary-button" disabled={!!busy} onClick={shareLink}>
              <Share2 size={17} />
              {busy === 'share' ? 'Abrindo…' : 'Compartilhar convite'}
            </button>
          </div>
          <a
            className="referral-preview-link"
            href={link}
            target="_blank"
            rel="noopener noreferrer"
          >
            Ver meu convite
            <ExternalLink size={14} />
          </a>
        </section>
      </div>

      <section className="referral-numbers" aria-label="Resumo de recompensas">
        <div className="panel referral-number">
          <span className="referral-number-icon green">
            <Wallet size={19} />
          </span>
          <div>
            <span>Recompensas a receber</span>
            <strong>{currency(available, p.hidden)}</strong>
            <button onClick={() => setDialog('payout')}>
              Sobre o recebimento
              <ChevronRight size={13} />
            </button>
          </div>
        </div>
        <div className="panel referral-number">
          <span className="referral-number-icon blue">
            <ArrowDownLeft size={20} />
          </span>
          <div>
            <span>Recompensas recebidas</span>
            <strong>{currency(paid, p.hidden)}</strong>
            <small>Pix confirmado pela equipe</small>
          </div>
        </div>
        <div className="panel referral-number">
          <span className="referral-number-icon amber">
            <Clock3 size={19} />
          </span>
          <div>
            <span>Em validação</span>
            <strong>
              {validating}
              <small>{validating === 1 ? 'indicação' : 'indicações'}</small>
            </strong>
            <small>Ainda sem recompensa atribuída</small>
          </div>
        </div>
      </section>

      <div className="referral-workspace">
        <div className="referral-main" ref={content}>
          <SectionTabs<ReferralTab>
            items={tabs}
            value={tab}
            onChange={setTab}
            label="Área de indicações"
            prefix="referrals"
          />
          <div id="referrals-content" role="tabpanel" aria-labelledby={`referrals-tab-${tab}`}>
            {tab === 'invitations' && (
              <section className="panel referral-history">
                <div className="section-heading">
                  <div>
                    <h2>Cada convite, um novo começo.</h2>
                    <p>Acompanhe as etapas sem perder os detalhes.</p>
                  </div>
                  <Badge>Atualizado</Badge>
                </div>
                <div className="referral-list-toolbar">
                  <span>
                    <UsersRound size={16} />
                    {data.total} {data.total === 1 ? 'convite' : 'convites'}
                  </span>
                  <label>
                    Mostrar
                    <select
                      aria-label="Filtrar indicações"
                      value={filter}
                      onChange={(event) => {
                        setFilter(event.target.value as ReferralFilter);
                        setPage(1);
                      }}
                    >
                      <option value="all">Todas as indicações</option>
                      <option value="progress">Em andamento</option>
                      <option value="rewarded">Com recompensa</option>
                      <option value="ineligible">Não elegíveis</option>
                    </select>
                  </label>
                </div>
                <div className="referral-records">
                  {shown.map((record) => {
                    const Icon = statusIcon(record.status);
                    return (
                      <button
                        className="referral-record"
                        key={record.id}
                        onClick={() => setSelected(record)}
                      >
                        <span className={`referral-record-icon ${record.status}`}>
                          <Icon size={20} />
                        </span>
                        <span className="referral-record-copy">
                          <strong>{record.label}</strong>
                          <span>Convidado em {dateLabel(record.createdAt)}</span>
                          <Badge tone={statusTone(record.status)}>
                            {record.source.status === 'requested'
                              ? 'Pix solicitado'
                              : statusLabels[record.status]}
                          </Badge>
                        </span>
                        <span className="referral-record-value">
                          {record.reward !== null ? (
                            <strong>{currency(record.reward, p.hidden)}</strong>
                          ) : (
                            <small>
                              {record.status === 'ineligible'
                                ? 'Não atribuída'
                                : 'Ainda não atribuída'}
                            </small>
                          )}
                        </span>
                        <ChevronRight className="referral-record-arrow" size={16} />
                      </button>
                    );
                  })}
                </div>
                {!shown.length && (
                  <Empty
                    title={
                      filter === 'all'
                        ? 'Seu próximo convite começa aqui.'
                        : 'Nenhuma indicação neste estado'
                    }
                    description={
                      filter === 'all'
                        ? 'Compartilhe seu link e acompanhe as etapas das suas indicações neste espaço.'
                        : 'Escolha outro filtro para consultar suas indicações.'
                    }
                    action={
                      <button
                        className="secondary-button"
                        onClick={filter === 'all' ? copyLink : () => setFilter('all')}
                      >
                        {filter === 'all' ? (
                          <>
                            <Copy size={15} />
                            Copiar meu link
                          </>
                        ) : (
                          'Ver todas as indicações'
                        )}
                      </button>
                    }
                  />
                )}
                {data.total > data.pageSize && (
                  <div className="referral-list-toolbar">
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={page === 1 || query.loading}
                      onClick={() => setPage((value) => value - 1)}
                    >
                      Anterior
                    </button>
                    <span>
                      {page} de {Math.ceil(data.total / data.pageSize)}
                    </span>
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={page * data.pageSize >= data.total || query.loading}
                      onClick={() => setPage((value) => value + 1)}
                    >
                      Próxima
                    </button>
                  </div>
                )}
                <div className="referral-history-note">
                  <ShieldCheck size={15} />
                  <p>
                    Você acompanha o progresso do convite. Dados pessoais e registros financeiros do
                    convidado permanecem privados.
                  </p>
                </div>
              </section>
            )}

            {tab === 'how' && (
              <section className="panel referral-how">
                <div className="section-heading">
                  <div>
                    <h2>Do seu convite à recompensa.</h2>
                    <p>Etapas pensadas para a experiência do Astra.</p>
                  </div>
                  <Link2 size={21} />
                </div>
                <ol className="referral-step-list">
                  {referralSteps.map((step, index) => {
                    const Icon = stepIcons[step.icon];
                    return (
                      <li key={step.title}>
                        <span className="referral-step-number">
                          {String(index + 1).padStart(2, '0')}
                        </span>
                        <span className="referral-step-icon">
                          <Icon size={21} />
                        </span>
                        <div>
                          <h3>{step.title}</h3>
                          <p>{step.description}</p>
                          {step.icon === 'sparkles' && (
                            <small className="referral-optional-step">
                              Sugestão para conhecer o Astra · não é condição para a recompensa.
                            </small>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ol>
                <div className="referral-how-callout">
                  <Gift size={21} />
                  <div>
                    <h3>A recompensa vem depois da validação.</h3>
                    <p>
                      O valor será variável entre R$ {campaign.minReward} e R$ {campaign.maxReward},
                      conforme o regulamento da campanha. Clicar no link ou iniciar um teste não
                      gera recompensa.
                    </p>
                  </div>
                </div>
                <button className="primary-button" onClick={copyLink}>
                  <Copy size={16} />
                  Copiar meu link
                </button>
              </section>
            )}

            {tab === 'rules' && (
              <section className="panel referral-rules">
                <div className="section-heading">
                  <div>
                    <h2>Clareza também nas condições.</h2>
                    <p>Condições para indicar e receber pelo Astra.</p>
                  </div>
                  <ShieldCheck size={22} />
                </div>
                <div className="referral-rules-summary">
                  <div>
                    <span>Recompensa variável</span>
                    <strong>
                      R$ {campaign.minReward} a R$ {campaign.maxReward}
                    </strong>
                  </div>
                  <div>
                    <span>Limite por mês</span>
                    <strong>{campaign.rewardLimit} indicações elegíveis</strong>
                  </div>
                  <div>
                    <span>Recebimento</span>
                    <strong>Pix manual</strong>
                  </div>
                </div>
                <div className="referral-rule-list">
                  {referralRules.map((rule, index) => (
                    <article key={rule.title}>
                      <span>{String(index + 1).padStart(2, '0')}</span>
                      <div>
                        <h3>{rule.title}</h3>
                        <p>{rule.description}</p>
                      </div>
                    </article>
                  ))}
                </div>
                <div className="referral-rules-footnote">
                  <Clock3 size={17} />
                  <p>
                    A equipe valida a assinatura e realiza o Pix manualmente. Acompanhe cada decisão
                    pelo histórico; não há transferência automática ao solicitar o recebimento.
                  </p>
                </div>
              </section>
            )}
          </div>
        </div>

        <aside className="referral-aside">
          <section className="panel referral-round">
            <div className="section-heading">
              <h2>Seu espaço para indicar</h2>
              <Gift size={18} />
            </div>
            <div className="referral-round-count">
              <strong>
                {Math.min(rewarded, campaign.rewardLimit)}
                <span> / {campaign.rewardLimit}</span>
              </strong>
              <span>
                recompensas
                <br />
                neste mês
              </span>
            </div>
            <div
              className="referral-round-progress"
              role="progressbar"
              aria-label="Limite mensal de recompensas"
              aria-valuenow={Math.min(rewarded, campaign.rewardLimit)}
              aria-valuemin={0}
              aria-valuemax={campaign.rewardLimit}
            >
              {Array.from({ length: campaign.rewardLimit }, (_, index) => (
                <span key={index} className={index < rewarded ? 'filled' : ''}>
                  {index < rewarded && <Check size={14} />}
                </span>
              ))}
            </div>
            <p>
              Uma indicação conta para o limite do mês em que sua recompensa é aprovada, no horário
              de São Paulo.
            </p>
            {inProgress > 0 && (
              <div className="referral-round-pending">
                <Clock3 size={15} />
                {inProgress} {inProgress === 1 ? 'convite em andamento' : 'convites em andamento'}
              </div>
            )}
            <button className="text-button" onClick={() => openTab('rules')}>
              Entender o limite
              <ArrowRight size={14} />
            </button>
          </section>
          <section className="referral-benefit">
            <span className="referral-benefit-icon">
              <MessageCircle size={21} />
            </span>
            <h3>Um Astra para os detalhes do dia.</h3>
            <p>Finanças, agenda, lembretes e metas na conversa que já faz parte da rotina.</p>
            <button className="text-button" onClick={() => openTab('how')}>
              Como apresentar o Astra
              <ArrowRight size={14} />
            </button>
          </section>
          <button className="referral-help-link" onClick={() => setDialog('help')}>
            <CircleHelp size={18} />
            <span>Uma dúvida sobre indicações?</span>
            <ChevronRight size={15} />
          </button>
        </aside>
      </div>

      <section className="panel referral-faq">
        <div className="section-heading">
          <div>
            <h2>Para indicar com tranquilidade.</h2>
            <p>As respostas que você precisa, antes de compartilhar.</p>
          </div>
          <CircleHelp size={21} />
        </div>
        <div>
          {referralFaqs.map((faq) => (
            <details key={faq.question}>
              <summary>
                {faq.question}
                <span>
                  <ChevronRight size={16} />
                </span>
              </summary>
              <p>{faq.answer}</p>
            </details>
          ))}
        </div>
      </section>

      {selected && (
        <ReferralDetail
          record={selected}
          hidden={p.hidden}
          onClose={() => setSelected(null)}
          onPayout={() => {
            setPayoutRecord(selected);
            setSelected(null);
            setPixKey('');
            setPayoutError('');
            setDialog('pix');
          }}
        />
      )}
      {dialog === 'copy' && (
        <Modal
          title="Copie seu convite"
          subtitle="O acesso à área de transferência não está disponível neste navegador."
          onClose={() => setDialog(null)}
        >
          <label className="field">
            Seu link de indicação
            <input
              ref={copyInput}
              aria-label="Link para copiar manualmente"
              value={link}
              readOnly
              onFocus={(event) => event.currentTarget.select()}
            />
          </label>
          <p className="form-hint">Selecione e copie o link pelo seu dispositivo.</p>
          <div className="modal-actions">
            <button className="secondary-button" onClick={() => setDialog(null)}>
              Voltar
            </button>
            <button
              className="primary-button"
              onClick={() => {
                copyInput.current?.focus();
                copyInput.current?.select();
              }}
            >
              Selecionar link
            </button>
          </div>
        </Modal>
      )}
      {dialog === 'payout' && (
        <Modal
          title="Sua recompensa, com clareza"
          subtitle="Como será o recebimento"
          onClose={() => setDialog(null)}
        >
          <div className="referral-payout-visual">
            <span>
              <Gift size={28} />
            </span>
            <h3>
              Primeiro a validação.
              <br />
              Depois, o recebimento.
            </h3>
            <p>
              Quando uma indicação cumprir todas as condições, sua recompensa aparecerá como
              disponível nesta área.
            </p>
          </div>
          <div className="referral-payout-steps">
            <div>
              <span>1</span>
              <p>O Astra confirma a assinatura e a elegibilidade da indicação.</p>
            </div>
            <div>
              <span>2</span>
              <p>O valor da recompensa é atribuído conforme o regulamento da campanha.</p>
            </div>
            <div>
              <span>3</span>
              <p>Você acompanha a liberação e o pagamento pelo histórico.</p>
            </div>
          </div>
          <div className="notice">
            <ShieldCheck size={18} />
            <p>
              O Pix é realizado manualmente após a validação da assinatura e a conferência da sua
              chave. Solicite o recebimento nos detalhes de uma recompensa aprovada e acompanhe o
              status salvo no histórico.
            </p>
          </div>
          <p className="form-hint">
            Recompensas de indicação ficam separadas dos seus registros financeiros.
          </p>
          <div className="modal-actions">
            <button className="primary-button" onClick={() => setDialog(null)}>
              Entendi
            </button>
          </div>
        </Modal>
      )}
      {dialog === 'pix' && payoutRecord && (
        <Modal
          title="Solicitar recebimento por Pix"
          subtitle={payoutRecord.label}
          onClose={() => setDialog(null)}
          busy={busy === 'pix'}
        >
          <div className="referral-detail-status available">
            <span>
              <Wallet size={25} />
            </span>
            <Badge tone="success">Recompensa aprovada</Badge>
            <strong>{currency(payoutRecord.reward ?? 0, p.hidden)}</strong>
          </div>
          <form onSubmit={submitPayout}>
            <label className="field">
              Sua chave Pix
              <input
                value={pixKey}
                onChange={(event) => setPixKey(event.target.value)}
                minLength={3}
                maxLength={140}
                required
                autoComplete="off"
                placeholder="CPF, CNPJ, e-mail, telefone ou chave aleatória"
                disabled={busy === 'pix' || !customer.access.canWrite}
              />
            </label>
            <p className="form-hint">
              Use uma chave de sua titularidade. A equipe confere os dados e realiza a transferência
              manualmente.
            </p>
            {payoutError && <CustomerError error={new Error(payoutError)} />}
            <div className="modal-actions transaction-form-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => setDialog(null)}
                disabled={busy === 'pix'}
              >
                Cancelar
              </button>
              <button
                className="primary-button"
                disabled={busy === 'pix' || !customer.access.canWrite}
              >
                {busy === 'pix' ? 'Registrando…' : 'Solicitar Pix'}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {dialog === 'help' && (
        <Modal
          title="Indique com tranquilidade"
          subtitle="Tudo começa com condições claras."
          onClose={() => setDialog(null)}
        >
          <div className="referral-help-content">
            <CircleHelp size={30} />
            <h3>Você acompanha cada etapa por aqui.</h3>
            <p>
              Se um convite ainda não gerou uma recompensa, abra seus detalhes para conferir o
              estado e as condições que faltam.
            </p>
            <p>
              A equipe confere as assinaturas e realiza os pagamentos manualmente. O painel
              apresenta o andamento real dos seus convites, pedidos e recebimentos.
            </p>
          </div>
          <div className="modal-actions">
            <button
              className="secondary-button"
              onClick={() => {
                setDialog(null);
                openTab('rules');
              }}
            >
              Consultar regras
            </button>
            <button className="primary-button" onClick={() => setDialog(null)}>
              Entendi
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function ReferralDetail({
  record,
  hidden,
  onClose,
  onPayout,
}: {
  record: ReferralRecord;
  hidden: boolean;
  onClose: () => void;
  onPayout: () => void;
}) {
  const requiredSteps = [
    { title: 'Conta criada pelo link' },
    { title: 'WhatsApp ativado' },
    { title: 'Pagamento da assinatura confirmado' },
    { title: 'Indicação validada' },
  ];
  const completed = ['approved', 'requested', 'paid'].includes(record.source.status) ? 4 : 2;
  const Icon = statusIcon(record.status);
  return (
    <Modal title={record.label} subtitle="Acompanhamento da indicação" onClose={onClose}>
      <div className={`referral-detail-status ${record.status}`}>
        <span>
          <Icon size={25} />
        </span>
        <Badge tone={statusTone(record.status)}>
          {record.source.status === 'requested' ? 'Pix solicitado' : statusLabels[record.status]}
        </Badge>
        {record.reward !== null && <strong>{currency(record.reward, hidden)}</strong>}
        <p>
          {record.source.status === 'requested'
            ? 'Seu pedido de Pix foi registrado. A equipe está conferindo os dados para realizar o pagamento.'
            : statusDescriptions[record.status]}
        </p>
      </div>
      <dl className="detail-list">
        <div>
          <dt>Convite registrado</dt>
          <dd>{new Date(record.createdAt).toLocaleDateString('pt-BR')}</dd>
        </div>
        <div>
          <dt>Recompensa</dt>
          <dd>
            {record.reward !== null ? currency(record.reward, hidden) : 'Ainda não atribuída'}
          </dd>
        </div>
        <div>
          <dt>Dados do convidado</dt>
          <dd>Protegidos pelo Astra</dd>
        </div>
      </dl>
      <h3 className="referral-timeline-title">Etapas da indicação</h3>
      <ol className="referral-timeline">
        {requiredSteps.map((step, index) => (
          <li key={step.title} className={index < completed ? 'complete' : ''}>
            <span>{index < completed ? <Check size={13} /> : index + 1}</span>
            <div>
              <strong>{step.title}</strong>
              {index === completed && record.status !== 'ineligible' && (
                <small>Próxima etapa</small>
              )}
            </div>
          </li>
        ))}
      </ol>
      {record.reason && (
        <div className="referral-detail-reason">
          <CircleHelp size={17} />
          <p>{record.reason}</p>
        </div>
      )}
      <div className="modal-actions">
        <button className="secondary-button" onClick={onClose}>
          Voltar
        </button>
        {record.status === 'available' && (
          <button className="primary-button" onClick={onPayout}>
            Solicitar Pix
            <ChevronRight size={15} />
          </button>
        )}
      </div>
    </Modal>
  );
}

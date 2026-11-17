/** Manual investment ledger validator. All economic arithmetic uses fixed decimals. */
import type { MarketQuote, MarketHistory } from './investment-market';
export type AssetKind = 'stock' | 'etf' | 'fii';
export type OperationType =
  | 'OPEN_CASH'
  | 'OPEN_POSITION'
  | 'BUY'
  | 'SELL'
  | 'CASH_IN'
  | 'CASH_OUT'
  | 'INCOME'
  | 'FEE'
  | 'TRANSFER_CASH'
  | 'TRANSFER_ASSET'
  | 'SPLIT';
export type Portfolio = { id: string; name: string };
export type InvestmentAccount = { id: string; portfolioId: string; name: string };
export type MarketIdentity = {
  provider: 'BRAPI';
  symbol: string;
  kind: AssetKind;
  currency: 'BRL';
  exchange: 'B3';
  verifiedAt: string;
};
export type InvestmentAsset = {
  id: string;
  symbol: string;
  name: string;
  kind: AssetKind;
  quantum: string;
  pricingMode?: 'manual' | 'automatic';
  marketIdentity?: MarketIdentity;
};
export type OperationInput = {
  id?: string;
  accountId: string;
  type: OperationType;
  date: string;
  sequence: number;
  assetId?: string;
  quantity?: string;
  unitPrice?: string;
  fees?: string;
  amount?: string;
  gross?: string;
  withholding?: string;
  initialBasis?: string;
  counterAccountId?: string;
  transferGroupId?: string;
  ratioNumerator?: string;
  ratioDenominator?: string;
  sourceId?: string;
  externalId?: string;
  note?: string;
};
export type OperationVersion = {
  revision: number;
  changedAt: string;
  reason: string;
  data: OperationInput;
  status: 'confirmed' | 'cancelled';
};
export type InvestmentOperation = OperationInput & {
  id: string;
  revision: number;
  status: 'confirmed' | 'cancelled';
  createdAt: string;
  updatedAt: string;
  history: OperationVersion[];
  importFingerprint?: string;
};
export type QuoteProvenance = {
  origin?: 'manual' | 'automatic';
  provider?: 'BRAPI';
  symbol?: string;
  marketTimestamp?: string;
  fetchedAt?: string;
  observationType?: 'quote' | 'daily-close';
  barTimestamp?: string;
};
export type ManualQuote = QuoteProvenance & {
  id: string;
  assetId: string;
  date: string;
  price: string;
  source: string;
  recordedAt: string;
  history?: (QuoteProvenance & { price: string; source: string; recordedAt: string })[];
};
export type MarketGap = {
  assetId: string;
  date: string;
  source: 'BRAPI';
  fetchedAt: string;
  barTimestamp: string;
};
export type InvestmentState = {
  version: 1;
  revision: number;
  marketRevision?: number;
  portfolios: Portfolio[];
  accounts: InvestmentAccount[];
  assets: InvestmentAsset[];
  operations: InvestmentOperation[];
  quotes: ManualQuote[];
  marketGaps?: MarketGap[];
};
export type InvestmentScope = { date?: string; portfolioId?: string; accountId?: string };
export type InvestmentPosition = {
  accountId: string;
  assetId: string;
  quantity: string;
  cost: string | null;
  averagePrice: string | null;
  marketValue: string | null;
  unrealized: string | null;
  realized: string | null;
  income: string;
  quoteDate?: string;
  quoteSource?: string;
  quoteOrigin?: 'manual' | 'automatic';
  marketTimestamp?: string;
  fetchedAt?: string;
  price?: string;
  quality: 'current' | 'stale' | 'missing';
};
export type InvestmentSnapshot = {
  date: string;
  cash: string;
  cashComplete: boolean;
  knownValue: string;
  totalValue: string | null;
  cost: string | null;
  realized: string | null;
  unrealized: string | null;
  income: string;
  fees: string;
  positions: InvestmentPosition[];
  issues: string[];
  accounts: { accountId: string; cash: string; complete: boolean }[];
};
export type InvestmentPerformance = {
  returnRate: string | null;
  gain: string | null;
  reason?: string;
  sensitive: boolean;
  method: 'Modified Dietz';
  from: string;
  to: string;
  startValue?: string;
  endValue?: string;
  externalFlows?: string;
  denominator?: string;
};
export class InvestmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvestmentError';
  }
}

const SCALE = 1_000_000_000_000n;
const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const MAX_EVENT = 10n ** 27n;
const MAX_AGGREGATE = 10n ** 30n;
const economicFields = [
  'assetId',
  'quantity',
  'unitPrice',
  'fees',
  'amount',
  'gross',
  'withholding',
  'initialBasis',
  'counterAccountId',
  'ratioNumerator',
  'ratioDenominator',
] as const;
const allowed: Record<OperationType, readonly string[]> = {
  OPEN_CASH: ['amount'],
  OPEN_POSITION: ['assetId', 'quantity', 'initialBasis'],
  BUY: ['assetId', 'quantity', 'unitPrice', 'fees'],
  SELL: ['assetId', 'quantity', 'unitPrice', 'fees'],
  CASH_IN: ['amount'],
  CASH_OUT: ['amount'],
  INCOME: ['assetId', 'gross', 'withholding', 'amount'],
  FEE: ['amount', 'assetId'],
  TRANSFER_CASH: ['amount', 'counterAccountId'],
  TRANSFER_ASSET: ['assetId', 'quantity', 'counterAccountId'],
  SPLIT: ['assetId', 'ratioNumerator', 'ratioDenominator'],
};
const fail = (message: string): never => {
  throw new InvestmentError(message);
};
const has = (v: unknown) => v !== undefined && v !== null && v !== '';
const uuid = () => crypto.randomUUID();
export function investmentToday() {
  const parts = dayFormatter.formatToParts(new Date());
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
export function emptyInvestmentState(): InvestmentState {
  return {
    version: 1,
    revision: 0,
    marketRevision: 0,
    portfolios: [],
    accounts: [],
    assets: [],
    operations: [],
    quotes: [],
    marketGaps: [],
  };
}
function divideRound(a: bigint, b: bigint): bigint {
  if (b === 0n) return fail('Não é possível dividir por zero.');
  const negative = a < 0n !== b < 0n;
  const x = a < 0n ? -a : a,
    y = b < 0n ? -b : b;
  const q = x / y,
    r = x % y;
  return (negative ? -1n : 1n) * (q + (r * 2n >= y ? 1n : 0n));
}
function multiply(a: bigint, b: bigint) {
  return divideRound(a * b, SCALE);
}
function decimal(value: unknown, places = 12, label = 'Valor'): bigint {
  if (typeof value !== 'string' || value.length > 64 || !/^\d+(?:\.\d+)?$/.test(value))
    return fail(`${label}: use um número positivo com ponto decimal, sem separador de milhar.`);
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > places)
    return fail(`${label}: limite de ${places} casas decimais excedido.`);
  return BigInt(whole!) * SCALE + BigInt(fraction.padEnd(12, '0'));
}
export function investmentDecimal(value: string, places = 12): string {
  return textDecimal(decimal(value, places));
}
export function textDecimal(value: bigint): string {
  const negative = value < 0n;
  const a = negative ? -value : value;
  const fraction = (a % SCALE).toString().padStart(12, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${a / SCALE}${fraction ? `.${fraction}` : ''}`;
}
export function formatInvestmentMoney(value: string | null, hidden = false): string {
  if (hidden) return 'R$ ••••';
  if (value === null) return 'Indisponível';
  const negative = value.startsWith('-'),
    magnitude = decimal(negative ? value.slice(1) : value);
  const cents = divideRound(magnitude, 10_000_000_000n),
    whole = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${negative && cents ? '− ' : ''}R$ ${whole},${(cents % 100n).toString().padStart(2, '0')}`;
}
export function formatInvestmentQuantity(value: string): string {
  const [whole, fraction] = value.split('.');
  return `${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, '.')}${fraction ? `,${fraction}` : ''}`;
}
export function formatInvestmentPercent(value: string | null, hidden = false): string {
  if (hidden) return '•••%';
  if (value === null) return 'Indisponível';
  const negative = value.startsWith('-');
  const n = decimal(negative ? value.slice(1) : value);
  const hundredths = divideRound(n * 10_000n, SCALE);
  return `${negative && hundredths ? '−' : ''}${hundredths / 100n},${(hundredths % 100n).toString().padStart(2, '0')}%`;
}
function dateValue(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return fail('Informe uma data no formato AAAA-MM-DD.');
  const n = Date.parse(`${value}T12:00:00Z`);
  if (!Number.isFinite(n) || new Date(n).toISOString().slice(0, 10) !== value)
    return fail('Data inválida.');
  return n;
}
function nameValue(value: string, label: string) {
  const n = value?.trim();
  if (!n || n.length > 80 || /[\u0000-\u001f]/.test(n))
    return fail(`${label}: informe entre 1 e 80 caracteres.`);
  return n;
}
function uniqueId(id?: string) {
  const value = id || uuid();
  if (value.length > 80 || !/^[A-Za-z0-9_.:-]+$/.test(value))
    return fail('Identificador inválido.');
  return value;
}
function changed(state: InvestmentState, fields: Partial<InvestmentState>) {
  return { ...state, ...fields, revision: state.revision + 1 };
}
export function addPortfolio(
  state: InvestmentState,
  input: { id?: string; name: string }
): InvestmentState {
  const id = uniqueId(input.id);
  if (state.portfolios.some((p) => p.id === id))
    return fail('Já existe uma carteira com esse identificador.');
  return changed(state, {
    portfolios: [...state.portfolios, { id, name: nameValue(input.name, 'Nome da carteira') }],
  });
}
export function addAccount(
  state: InvestmentState,
  input: { id?: string; portfolioId: string; name: string }
): InvestmentState {
  const id = uniqueId(input.id);
  if (!state.portfolios.some((p) => p.id === input.portfolioId))
    return fail('Carteira não encontrada.');
  if (state.accounts.some((a) => a.id === id))
    return fail('Já existe uma conta com esse identificador.');
  return changed(state, {
    accounts: [
      ...state.accounts,
      { id, portfolioId: input.portfolioId, name: nameValue(input.name, 'Nome da custódia') },
    ],
  });
}
function verifiedIdentity(
  identity: MarketIdentity | undefined,
  symbol: string,
  kind: AssetKind
): MarketIdentity {
  if (
    !identity ||
    identity.provider !== 'BRAPI' ||
    identity.symbol !== symbol ||
    identity.kind !== kind ||
    identity.currency !== 'BRL' ||
    identity.exchange !== 'B3' ||
    !Number.isFinite(Date.parse(identity.verifiedAt)) ||
    Date.parse(identity.verifiedAt) > Date.now()
  )
    return fail(
      'Confirme a identidade, classe e moeda deste ativo pela busca do provedor antes de ativar cotações automáticas.'
    );
  return {
    provider: 'BRAPI',
    symbol,
    kind,
    currency: 'BRL',
    exchange: 'B3',
    verifiedAt: new Date(identity.verifiedAt).toISOString(),
  };
}
export function addAsset(
  state: InvestmentState,
  input: {
    id?: string;
    symbol: string;
    name: string;
    kind: AssetKind;
    quantum?: string;
    pricingMode?: 'manual' | 'automatic';
    marketIdentity?: MarketIdentity;
  }
): InvestmentState {
  const id = uniqueId(input.id),
    symbol = nameValue(input.symbol, 'Código').toUpperCase();
  if (state.assets.some((a) => a.id === id || a.symbol === symbol))
    return fail('Esse ativo já está cadastrado.');
  if (!['stock', 'etf', 'fii'].includes(input.kind))
    return fail('Classe de ativo fora desta versão.');
  const quantum = decimal(input.quantum || '1', 8, 'Unidade negociável');
  if (quantum <= 0n) return fail('A unidade negociável deve ser maior que zero.');
  if (input.pricingMode && !['manual', 'automatic'].includes(input.pricingMode))
    return fail('Modo de preço inválido.');
  const identity = input.marketIdentity
    ? verifiedIdentity(input.marketIdentity, symbol, input.kind)
    : undefined;
  if (input.pricingMode === 'automatic') {
    verifiedIdentity(identity, symbol, input.kind);
    if (quantum !== SCALE)
      return fail('A negociação automática de preços exige unidades inteiras para este ativo B3.');
  }
  const assetName = input.name?.trim();
  if (!assetName || assetName.length > 160 || /[\u0000-\u001f]/.test(assetName))
    return fail('O nome do ativo deve ter entre 1 e 160 caracteres.');
  return changed(state, {
    assets: [
      ...state.assets,
      {
        id,
        symbol,
        name: assetName,
        kind: input.kind,
        quantum: textDecimal(quantum),
        ...(input.pricingMode ? { pricingMode: input.pricingMode } : {}),
        ...(identity ? { marketIdentity: identity } : {}),
      },
    ],
  });
}
export function setAssetPricingMode(
  state: InvestmentState,
  assetId: string,
  pricingMode: 'manual' | 'automatic',
  marketIdentity?: MarketIdentity
): InvestmentState {
  const asset = state.assets.find((a) => a.id === assetId);
  if (!asset) return fail('Ativo não encontrado.');
  if (!['manual', 'automatic'].includes(pricingMode)) return fail('Modo de preço inválido.');
  const identity = marketIdentity || asset.marketIdentity;
  if (pricingMode === 'automatic') {
    verifiedIdentity(identity, asset.symbol, asset.kind);
    if (decimal(asset.quantum) !== SCALE)
      return fail('A unidade negociável precisa ser inteira para este ativo B3.');
  }
  if (
    (asset.pricingMode || 'manual') === pricingMode &&
    (!marketIdentity || JSON.stringify(marketIdentity) === JSON.stringify(asset.marketIdentity))
  )
    return state;
  return changed(state, {
    assets: state.assets.map((a) =>
      a.id === assetId
        ? {
            ...a,
            pricingMode,
            ...(identity
              ? { marketIdentity: verifiedIdentity(identity, asset.symbol, asset.kind) }
              : {}),
          }
        : a
    ),
  });
}
function operationData(op: OperationInput): OperationInput {
  const clean: OperationInput = {
    accountId: op.accountId,
    type: op.type,
    date: op.date,
    sequence: op.sequence,
  };
  for (const key of [
    ...economicFields,
    'transferGroupId',
    'sourceId',
    'externalId',
    'note',
  ] as const)
    if (has(op[key])) clean[key] = op[key];
  return clean;
}
function fingerprint(input: OperationInput) {
  return JSON.stringify(operationData(input));
}
function normalize(state: InvestmentState, input: OperationInput): OperationInput {
  if (!input || !allowed[input.type]) return fail('Tipo de movimentação inválido.');
  if (!state.accounts.some((a) => a.id === input.accountId))
    return fail('Conta de custódia não encontrada.');
  dateValue(input.date);
  if (input.date > investmentToday())
    return fail(
      'Movimentações futuras não são recebimentos confirmados. Escolha hoje ou uma data anterior.'
    );
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1 || input.sequence > 1_000_000)
    return fail('Informe uma ordem inteira entre 1 e 1.000.000.');
  const out = operationData(input);
  if (out.note && out.note.length > 240) return fail('A observação pode ter até 240 caracteres.');
  for (const field of economicFields)
    if (has(out[field]) && !allowed[input.type].includes(field))
      return fail(`O campo ${field} não se aplica a esta movimentação.`);
  if (allowed[input.type].includes('assetId') && input.type !== 'FEE' && !out.assetId)
    return fail('Selecione um ativo.');
  if (out.assetId && !state.assets.some((a) => a.id === out.assetId))
    return fail('Ativo não encontrado.');
  for (const field of [
    'quantity',
    'unitPrice',
    'fees',
    'amount',
    'gross',
    'withholding',
    'initialBasis',
  ] as const)
    if (has(out[field])) {
      const v = decimal(
        out[field],
        field === 'quantity' || field === 'unitPrice' ? 8 : field === 'initialBasis' ? 12 : 2,
        field
      );
      if (v > (field === 'quantity' ? 10n ** 24n : field === 'unitPrice' ? 10n ** 21n : MAX_EVENT))
        return fail(`${field}: valor acima do limite permitido.`);
      out[field] = textDecimal(v);
    }
  if (['BUY', 'SELL', 'OPEN_POSITION', 'TRANSFER_ASSET'].includes(out.type)) {
    const q = decimal(out.quantity, 8, 'Quantidade');
    if (q <= 0n) return fail('A quantidade deve ser maior que zero.');
    const a = state.assets.find((a) => a.id === out.assetId)!;
    if (q % decimal(a.quantum, 8) !== 0n)
      return fail(`A quantidade deve ser múltipla de ${a.quantum} para este ativo.`);
  }
  if (out.type === 'BUY' || out.type === 'SELL') {
    if (decimal(out.unitPrice, 8, 'Preço') <= 0n) return fail('O preço deve ser maior que zero.');
    out.fees ??= '0';
    const gross = multiply(decimal(out.quantity), decimal(out.unitPrice));
    if (gross > MAX_EVENT || gross + decimal(out.fees) > MAX_EVENT)
      return fail('O total da operação excede o limite.');
  }
  if (
    ['CASH_IN', 'CASH_OUT', 'FEE', 'TRANSFER_CASH'].includes(out.type) &&
    decimal(out.amount, 2, 'Valor') <= 0n
  )
    return fail('O valor deve ser maior que zero.');
  if (out.type === 'OPEN_CASH') decimal(out.amount, 2, 'Caixa inicial');
  if (out.type === 'INCOME') {
    const gross = decimal(out.gross, 2, 'Provento bruto'),
      tax = decimal(out.withholding, 2, 'Retenção');
    if (tax > gross) return fail('A retenção não pode ser maior que o provento bruto.');
    if (has(out.amount) && decimal(out.amount) !== gross - tax)
      return fail('O líquido precisa ser igual ao bruto menos a retenção.');
    out.amount = textDecimal(gross - tax);
  }
  if (out.type === 'TRANSFER_CASH' || out.type === 'TRANSFER_ASSET') {
    if (!state.accounts.some((a) => a.id === out.counterAccountId))
      return fail('Selecione uma conta de destino deste espaço.');
    if (out.counterAccountId === out.accountId)
      return fail('Origem e destino devem ser diferentes.');
    if (out.transferGroupId) out.transferGroupId = uniqueId(out.transferGroupId);
  } else if (has(out.transferGroupId))
    return fail('Grupo de transferência só se aplica a transferências.');
  if (out.type === 'SPLIT') {
    if (!out.note || out.note.trim().length < 3)
      return fail('Informe na observação a fonte conferida da razão e da data do evento.');
    for (const field of ['ratioNumerator', 'ratioDenominator'] as const) {
      const value = out[field];
      if (!value || !/^\d{1,9}$/.test(value) || BigInt(value) === 0n)
        return fail('A razão do evento deve usar inteiros positivos até 999.999.999.');
      out[field] = BigInt(value).toString();
    }
  }
  if (has(out.sourceId) !== has(out.externalId))
    return fail('A identidade de importação precisa de fonte e identificador.');
  if (out.sourceId) out.sourceId = uniqueId(out.sourceId);
  if (out.externalId) out.externalId = uniqueId(out.externalId);
  return out;
}

type LedgerPosition = {
  accountId: string;
  assetId: string;
  quantity: bigint;
  cost: bigint | null;
  realized: bigint | null;
  income: bigint;
};
type LedgerAccount = { cash: bigint; fees: bigint; income: bigint; realized: bigint | null };
type Ledger = { positions: Map<string, LedgerPosition>; accounts: Map<string, LedgerAccount> };
function selectedAccounts(state: InvestmentState, scope: InvestmentScope) {
  return state.accounts.filter(
    (a) =>
      (!scope.portfolioId || a.portfolioId === scope.portfolioId) &&
      (!scope.accountId || a.id === scope.accountId)
  );
}
function ordered(state: InvestmentState, date = '9999-12-31') {
  return state.operations
    .filter((o) => o.status === 'confirmed' && o.date <= date)
    .sort(
      (a, b) => a.date.localeCompare(b.date) || a.sequence - b.sequence || a.id.localeCompare(b.id)
    );
}
function ledger(state: InvestmentState, date = '9999-12-31'): Ledger {
  const result: Ledger = {
    positions: new Map(),
    accounts: new Map(
      state.accounts.map((a) => [a.id, { cash: 0n, fees: 0n, income: 0n, realized: 0n }])
    ),
  };
  const p = (accountId: string, assetId: string): LedgerPosition => {
    const key = `${accountId}|${assetId}`;
    let position = result.positions.get(key);
    if (!position) {
      position = { accountId, assetId, quantity: 0n, cost: 0n, realized: 0n, income: 0n };
      result.positions.set(key, position);
    }
    return position;
  };
  const openCash = new Set<string>(),
    usedCash = new Set<string>(),
    openedPositions = new Set<string>(),
    usedPositions = new Set<string>();
  const orderKeys = new Set<string>();
  for (const op of ordered(state, date)) {
    const key = `${op.accountId}|${op.date}|${op.sequence}`;
    if (orderKeys.has(key))
      return fail(`${op.date}: há duas movimentações com a mesma ordem na mesma conta.`);
    orderKeys.add(key);
    if (op.counterAccountId) {
      const targetKey = `${op.counterAccountId}|${op.date}|${op.sequence}`;
      if (orderKeys.has(targetKey))
        return fail('A ordem da transferência conflita com a conta de destino.');
      orderKeys.add(targetKey);
    }
    const account = result.accounts.get(op.accountId);
    if (!account) return fail('Uma movimentação aponta para conta inexistente.');
    const position = op.assetId ? p(op.accountId, op.assetId) : undefined;
    const q = op.quantity ? decimal(op.quantity) : 0n,
      price = op.unitPrice ? decimal(op.unitPrice) : 0n,
      fee = op.fees ? decimal(op.fees) : 0n,
      amount = op.amount ? decimal(op.amount) : 0n;
    const positionKey = op.assetId ? `${op.accountId}|${op.assetId}` : '';
    if (op.type === 'OPEN_CASH') {
      if (openCash.has(op.accountId) || usedCash.has(op.accountId))
        return fail('O caixa inicial precisa ser a primeira movimentação de caixa da conta.');
      openCash.add(op.accountId);
      account.cash = amount;
    } else if (op.type === 'OPEN_POSITION') {
      if (openedPositions.has(positionKey) || usedPositions.has(positionKey))
        return fail('A posição inicial deve ser o primeiro registro desse ativo na conta.');
      openedPositions.add(positionKey);
      position!.quantity = q;
      position!.cost = has(op.initialBasis) ? decimal(op.initialBasis) : null;
    } else if (op.type === 'BUY') {
      const value = multiply(q, price) + fee;
      account.cash -= value;
      position!.quantity += q;
      if (position!.cost !== null) position!.cost += value;
      account.fees += fee;
    } else if (op.type === 'SELL' || op.type === 'TRANSFER_ASSET') {
      if (!position || q > position.quantity || q <= 0n)
        return fail(`${op.date}: quantidade insuficiente para vender ou transferir o ativo.`);
      const basis =
        position.cost === null
          ? null
          : q === position.quantity
            ? position.cost
            : divideRound(position.cost * q, position.quantity);
      if (op.type === 'SELL') {
        const proceeds = multiply(q, price) - fee;
        account.cash += proceeds;
        account.fees += fee;
        if (basis === null) {
          position.realized = null;
          account.realized = null;
        } else {
          const gain = proceeds - basis;
          if (position.realized !== null) position.realized += gain;
          if (account.realized !== null) account.realized += gain;
        }
      } else {
        if (basis === null) return fail('Informe o custo de origem antes de transferir o ativo.');
        const target = p(op.counterAccountId!, op.assetId!);
        target.quantity += q;
        if (target.cost !== null) target.cost += basis;
        usedPositions.add(`${op.counterAccountId}|${op.assetId}`);
      }
      position.quantity -= q;
      position.cost =
        position.quantity === 0n ? 0n : basis === null ? null : position.cost! - basis;
    } else if (op.type === 'CASH_IN') account.cash += amount;
    else if (op.type === 'CASH_OUT') account.cash -= amount;
    else if (op.type === 'INCOME') {
      account.cash += amount;
      account.income += amount;
      position!.income += amount;
    } else if (op.type === 'FEE') {
      account.cash -= amount;
      account.fees += amount;
      if (account.realized !== null) account.realized -= amount;
    } else if (op.type === 'TRANSFER_CASH') {
      account.cash -= amount;
      result.accounts.get(op.counterAccountId!)!.cash += amount;
      usedCash.add(op.counterAccountId!);
    } else if (op.type === 'SPLIT') {
      if (!position || position.quantity === 0n)
        return fail('Não há posição para aplicar esse evento.');
      const n = BigInt(op.ratioNumerator!),
        d = BigInt(op.ratioDenominator!);
      const exact = position.quantity * n,
        quantum = decimal(state.assets.find((a) => a.id === op.assetId)!.quantum, 8);
      if (exact % d !== 0n || (exact / d) % 10_000n !== 0n || (exact / d) % quantum !== 0n)
        return fail(
          'O evento produz fração que exige conciliação. Nenhuma quantidade foi arredondada.'
        );
      position.quantity = exact / d;
    }
    if (!['OPEN_POSITION', 'SPLIT', 'TRANSFER_ASSET'].includes(op.type)) usedCash.add(op.accountId);
    if (op.assetId && op.type !== 'OPEN_POSITION') usedPositions.add(positionKey);
    for (const a of result.accounts.values()) {
      if (a.cash < 0n)
        return fail(
          `${op.date}: o caixa ficaria negativo. Registre o caixa inicial ou aporte antes desta operação.`
        );
      if (a.cash > MAX_AGGREGATE) return fail('O caixa agregado excede o limite permitido.');
    }
    for (const pos of result.positions.values())
      if (pos.quantity > 10n ** 24n || (pos.cost !== null && pos.cost > MAX_AGGREGATE))
        return fail('A posição agregada excede o limite permitido.');
    const totals = new Map<string, { cash: bigint; cost: bigint }>();
    for (const a of state.accounts) {
      const group = totals.get(a.portfolioId) || { cash: 0n, cost: 0n };
      group.cash += result.accounts.get(a.id)!.cash;
      totals.set(a.portfolioId, group);
    }
    for (const pos of result.positions.values()) {
      const portfolioId = state.accounts.find((a) => a.id === pos.accountId)!.portfolioId;
      if (pos.cost !== null) totals.get(portfolioId)!.cost += pos.cost;
    }
    if ([...totals.values()].some((v) => v.cash > MAX_AGGREGATE || v.cost > MAX_AGGREGATE))
      return fail('O caixa ou custo agregado da carteira excede R$ 1 quintilhão.');
  }
  return result;
}

export function previewOperation(
  state: InvestmentState,
  input: OperationInput,
  editingId?: string
): InvestmentSnapshot {
  return getSnapshot(saveOperation(state, input, editingId), {
    accountId: input.accountId,
    date: input.date,
  });
}
export function saveOperation(
  state: InvestmentState,
  input: OperationInput,
  editingId?: string
): InvestmentState {
  const old = editingId ? state.operations.find((o) => o.id === editingId) : undefined;
  if (
    old &&
    ((input.sourceId && input.sourceId !== old.sourceId) ||
      (input.externalId && input.externalId !== old.externalId))
  )
    return fail('A identidade original de importação não pode ser alterada.');
  const normalized = normalize(
      state,
      old?.sourceId ? { ...input, sourceId: old.sourceId, externalId: old.externalId } : input
    ),
    now = new Date().toISOString();
  if (editingId && !old) return fail('Movimentação não encontrada.');
  if (old?.status === 'cancelled')
    return fail('Uma movimentação cancelada não pode ser reativada.');
  if (
    (normalized.type === 'TRANSFER_CASH' || normalized.type === 'TRANSFER_ASSET') &&
    !normalized.transferGroupId
  ) {
    const previous =
      old ||
      state.operations.find(
        (o) =>
          (input.id && o.id === input.id) ||
          (normalized.sourceId &&
            o.sourceId === normalized.sourceId &&
            o.externalId === normalized.externalId)
      );
    normalized.transferGroupId = previous?.transferGroupId || uuid();
  }
  if (!editingId && normalized.sourceId && normalized.externalId) {
    const duplicate = state.operations.find(
      (o) => o.sourceId === normalized.sourceId && o.externalId === normalized.externalId
    );
    if (duplicate) {
      if ((duplicate.importFingerprint || fingerprint(duplicate)) !== fingerprint(normalized))
        return fail(
          'Identificador externo já utilizado com dados diferentes. Use a correção da movimentação.'
        );
      return state;
    }
  }
  const id = old?.id || uniqueId(input.id);
  const sameId = !old ? state.operations.find((o) => o.id === id) : undefined;
  if (sameId) {
    if (fingerprint(sameId) === fingerprint(normalized)) return state;
    return fail('Identificador de movimentação já utilizado com dados diferentes.');
  }
  const operation: InvestmentOperation = {
    ...normalized,
    id,
    revision: old ? old.revision + 1 : 1,
    status: 'confirmed',
    createdAt: old?.createdAt || now,
    updatedAt: now,
    history: old
      ? [
          ...old.history,
          {
            revision: old.revision,
            changedAt: now,
            reason: input.note?.trim().slice(0, 80) || 'Correção manual',
            data: operationData(old),
            status: old.status,
          },
        ]
      : [],
    ...(old?.importFingerprint
      ? { importFingerprint: old.importFingerprint }
      : normalized.sourceId
        ? { importFingerprint: fingerprint(normalized) }
        : {}),
  };
  const candidate = changed(state, {
    operations: old
      ? state.operations.map((o) => (o.id === id ? operation : o))
      : [...state.operations, operation],
  });
  ledger(candidate);
  return candidate;
}
export function cancelOperation(
  state: InvestmentState,
  id: string,
  reason = 'Cancelamento manual'
): InvestmentState {
  const old = state.operations.find((o) => o.id === id);
  if (!old) return fail('Movimentação não encontrada.');
  if (old.status === 'cancelled') return state;
  const now = new Date().toISOString();
  const candidate = changed(state, {
    operations: state.operations.map((o) =>
      o.id === id
        ? {
            ...o,
            revision: o.revision + 1,
            status: 'cancelled',
            updatedAt: now,
            history: [
              ...o.history,
              {
                revision: o.revision,
                changedAt: now,
                reason: nameValue(reason, 'Motivo'),
                data: operationData(o),
                status: o.status,
              },
            ],
          }
        : o
    ),
  });
  ledger(candidate);
  return candidate;
}
export function saveManualQuote(
  state: InvestmentState,
  input: { id?: string; assetId: string; date: string; price: string; source: string }
): InvestmentState {
  if (!state.assets.some((a) => a.id === input.assetId)) return fail('Ativo não encontrado.');
  dateValue(input.date);
  if (input.date > investmentToday()) return fail('Não registre uma cotação futura.');
  const price = decimal(input.price, 8, 'Preço de mercado');
  if (price <= 0n || price > 10n ** 21n)
    return fail('Informe um preço maior que zero até R$ 1 bilhão.');
  const source = nameValue(input.source, 'Origem da cotação'),
    old = state.quotes.find(
      (q) => q.assetId === input.assetId && q.date === input.date && q.origin !== 'automatic'
    );
  const recordedAt = new Date().toISOString();
  const id = old?.id || uniqueId(input.id);
  if (!old && state.quotes.some((q) => q.id === id))
    return fail('Identificador de cotação já utilizado.');
  const quote: ManualQuote = {
    id,
    assetId: input.assetId,
    date: input.date,
    price: textDecimal(price),
    source,
    recordedAt,
    origin: 'manual',
    history: old ? [...(old.history || []), quoteVersion(old)] : [],
  };
  return changed(state, {
    quotes: old ? state.quotes.map((q) => (q.id === old.id ? quote : q)) : [...state.quotes, quote],
  });
}
function quoteVersion(
  q: ManualQuote
): QuoteProvenance & { price: string; source: string; recordedAt: string } {
  return {
    price: q.price,
    source: q.source,
    recordedAt: q.recordedAt,
    origin: q.origin || 'manual',
    ...(q.provider ? { provider: q.provider } : {}),
    ...(q.symbol ? { symbol: q.symbol } : {}),
    ...(q.marketTimestamp ? { marketTimestamp: q.marketTimestamp } : {}),
    ...(q.fetchedAt ? { fetchedAt: q.fetchedAt } : {}),
    ...(q.observationType ? { observationType: q.observationType } : {}),
    ...(q.barTimestamp ? { barTimestamp: q.barTimestamp } : {}),
  };
}
function sourceQuotes(state: InvestmentState, assetId: string) {
  const automatic = state.assets.find((a) => a.id === assetId)?.pricingMode === 'automatic';
  return state.quotes.filter(
    (q) =>
      q.assetId === assetId &&
      (q.origin === 'automatic') === automatic &&
      (!automatic ||
        (q.observationType === 'quote' && q.date === investmentToday()) ||
        !(state.marketGaps || []).some((g) => g.assetId === assetId && g.date === q.date))
  );
}
function quoteAt(state: InvestmentState, assetId: string, date: string) {
  return sourceQuotes(state, assetId)
    .filter((q) => q.date <= date)
    .sort((a, b) => b.date.localeCompare(a.date) || b.recordedAt.localeCompare(a.recordedAt))[0];
}
function sourceDate(instant: string): string {
  const ms = Date.parse(instant);
  if (!Number.isFinite(ms)) return fail('Data de mercado inválida.');
  const parts = dayFormatter.formatToParts(new Date(ms));
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
function autoQuoteValue(value: string) {
  const number = decimal(value, 8, 'Preço de mercado');
  if (number <= 0n || number > 10n ** 21n)
    return fail('Preço automático fora do intervalo permitido.');
  return textDecimal(number);
}
function marketTime(value: string, label: string) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || ms > Date.now())
    return fail(`${label} ausente, inválido ou no futuro.`);
  return new Date(ms).toISOString();
}
function storeAutomaticPoint(
  state: InvestmentState,
  input: Omit<ManualQuote, 'id' | 'history'>
): InvestmentState {
  const old = state.quotes.find(
    (q) => q.assetId === input.assetId && q.date === input.date && q.origin === 'automatic'
  );
  if (
    old &&
    old.price === input.price &&
    old.source === input.source &&
    old.observationType === input.observationType &&
    old.marketTimestamp === input.marketTimestamp &&
    old.barTimestamp === input.barTimestamp
  )
    return state;
  const quote: ManualQuote = {
    ...input,
    id: old?.id || uuid(),
    history: old ? [...(old.history || []), quoteVersion(old)] : [],
  };
  return {
    ...state,
    quotes: old ? state.quotes.map((q) => (q.id === old.id ? quote : q)) : [...state.quotes, quote],
  };
}
export function applyMarketQuotes(state: InvestmentState, quotes: MarketQuote[]): InvestmentState {
  let candidate = state;
  for (const quote of quotes) {
    const asset = state.assets.find(
      (a) => a.symbol === quote.symbol && a.pricingMode === 'automatic'
    );
    if (!asset) continue;
    verifiedIdentity(asset.marketIdentity, asset.symbol, asset.kind);
    if (
      quote.currency !== 'BRL' ||
      quote.source !== 'BRAPI' ||
      !['public-evaluation', 'authenticated-proxy'].includes(quote.provenance)
    )
      return fail('A origem ou identidade da cotação automática não foi validada.');
    const marketTimestamp = marketTime(quote.marketTimestamp, 'Horário de mercado'),
      fetchedAt = marketTime(quote.fetchedAt, 'Horário de consulta');
    if (marketTimestamp > fetchedAt)
      return fail('O horário de mercado não pode ser posterior à consulta.');
    const latest = candidate.quotes
      .filter((q) => q.assetId === asset.id && q.origin === 'automatic' && q.marketTimestamp)
      .sort((a, b) => b.marketTimestamp!.localeCompare(a.marketTimestamp!))[0];
    if (latest && latest.marketTimestamp! > marketTimestamp)
      return fail('Uma observação anterior não pode substituir o último preço conhecido.');
    candidate = storeAutomaticPoint(candidate, {
      assetId: asset.id,
      date: sourceDate(marketTimestamp),
      price: autoQuoteValue(quote.price),
      source: 'BRAPI · cotação de mercado',
      recordedAt: fetchedAt,
      origin: 'automatic',
      provider: 'BRAPI',
      symbol: quote.symbol,
      marketTimestamp,
      fetchedAt,
      observationType: 'quote',
    });
    if (
      (candidate.marketGaps || []).some(
        (g) => g.assetId === asset.id && g.date === sourceDate(marketTimestamp)
      )
    )
      candidate = {
        ...candidate,
        marketGaps: candidate.marketGaps!.filter(
          (g) => g.assetId !== asset.id || g.date !== sourceDate(marketTimestamp)
        ),
      };
  }
  return candidate === state
    ? state
    : { ...candidate, marketRevision: (state.marketRevision || 0) + 1 };
}
export function applyMarketHistory(
  state: InvestmentState,
  history: MarketHistory
): InvestmentState {
  const asset = state.assets.find(
    (a) => a.symbol === history.symbol && a.pricingMode === 'automatic'
  );
  if (!asset) return state;
  verifiedIdentity(asset.marketIdentity, asset.symbol, asset.kind);
  if (!Array.isArray(history.points) || history.points.length > 4000)
    return fail('Histórico incompatível com este ativo.');
  const fetchedAt = marketTime(history.fetchedAt, 'Consulta do histórico');
  let candidate = state;
  const dates = new Set<string>();
  const midnight = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Sao_Paulo',
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  for (const point of history.points) {
    if (
      point.raw !== true ||
      point.source !== 'BRAPI' ||
      point.fetchedAt !== history.fetchedAt ||
      point.date !== sourceDate(point.barTimestamp) ||
      midnight.format(new Date(point.barTimestamp)) !== '00:00:00' ||
      point.date > sourceDate(fetchedAt) ||
      dates.has(point.date)
    )
      return fail('O histórico deve conter preços brutos e datas diárias inequívocas.');
    dates.add(point.date);
    dateValue(point.date);
    const old = candidate.quotes.find(
      (q) => q.assetId === asset.id && q.date === point.date && q.origin === 'automatic'
    );
    if (old?.observationType === 'quote' && point.date === investmentToday()) continue;
    if (old?.fetchedAt && old.fetchedAt > fetchedAt) continue;
    const gap = (candidate.marketGaps || []).find(
      (g) => g.assetId === asset.id && g.date === point.date
    );
    if (point.price === null) {
      if (!gap)
        candidate = {
          ...candidate,
          marketGaps: [
            ...(candidate.marketGaps || []),
            {
              assetId: asset.id,
              date: point.date,
              source: 'BRAPI',
              fetchedAt,
              barTimestamp: point.barTimestamp,
            },
          ],
        };
      continue;
    }
    if (gap)
      candidate = { ...candidate, marketGaps: candidate.marketGaps!.filter((g) => g !== gap) };
    candidate = storeAutomaticPoint(candidate, {
      assetId: asset.id,
      date: point.date,
      price: autoQuoteValue(point.price),
      source: 'BRAPI · fechamento bruto',
      recordedAt: fetchedAt,
      origin: 'automatic',
      provider: 'BRAPI',
      symbol: history.symbol,
      fetchedAt,
      observationType: 'daily-close',
      barTimestamp: point.barTimestamp,
    });
  }
  return candidate === state
    ? state
    : { ...candidate, marketRevision: (state.marketRevision || 0) + 1 };
}
export type AssetPricePoint = {
  date: string;
  price: string | null;
  source: string;
  origin: 'manual' | 'automatic';
  marketTimestamp?: string;
  fetchedAt?: string;
  observationType?: 'quote' | 'daily-close';
};
export function getAssetPriceHistory(
  state: InvestmentState,
  assetId: string,
  period: { from?: string; to?: string } = {}
): AssetPricePoint[] {
  const points: AssetPricePoint[] = sourceQuotes(state, assetId).map((q) => ({
    date: q.date,
    price: q.price,
    source: q.source,
    origin: q.origin || 'manual',
    marketTimestamp: q.marketTimestamp,
    fetchedAt: q.fetchedAt,
    observationType: q.observationType,
  }));
  if (state.assets.find((a) => a.id === assetId)?.pricingMode === 'automatic')
    for (const gap of state.marketGaps || [])
      if (gap.assetId === assetId && !points.some((p) => p.date === gap.date))
        points.push({
          date: gap.date,
          price: null,
          source: 'BRAPI · preço bruto indisponível',
          origin: 'automatic',
          fetchedAt: gap.fetchedAt,
          observationType: 'daily-close',
        });
  return points
    .filter((p) => (!period.from || p.date >= period.from) && (!period.to || p.date <= period.to))
    .sort((a, b) => a.date.localeCompare(b.date));
}
function gainRate(
  gain: string | null,
  cost: string | null
): { gain: string | null; rate: string | null } {
  if (gain === null || cost === null) return { gain: null, rate: null };
  const basis = decimal(cost);
  if (basis <= 0n) return { gain, rate: null };
  const negative = gain.startsWith('-'),
    value = decimal(negative ? gain.slice(1) : gain) * (negative ? -1n : 1n);
  return { gain, rate: textDecimal(divideRound(value * SCALE, basis)) };
}
export function getPositionChange(position: InvestmentPosition): {
  gain: string | null;
  rate: string | null;
} {
  return gainRate(position.unrealized, position.cost);
}
export function getPortfolioChange(snapshot: InvestmentSnapshot): {
  gain: string | null;
  rate: string | null;
} {
  return snapshot.totalValue === null
    ? { gain: null, rate: null }
    : gainRate(snapshot.unrealized, snapshot.cost);
}
/** A user trade reviewed before a quote refresh must not roll market observations back. */
export function preserveAutomaticMarketData(
  candidate: InvestmentState,
  current: InvestmentState
): InvestmentState {
  if ((current.marketRevision || 0) <= (candidate.marketRevision || 0)) return candidate;
  const automatic = current.quotes.filter(
    (q) => q.origin === 'automatic' && candidate.assets.some((a) => a.id === q.assetId)
  );
  for (const q of automatic) validateQuoteObservation(candidate, q, q.assetId, q.date);
  return {
    ...candidate,
    quotes: [...candidate.quotes.filter((q) => q.origin !== 'automatic'), ...automatic],
    marketGaps: (current.marketGaps || []).filter((g) =>
      candidate.assets.some((a) => a.id === g.assetId)
    ),
    marketRevision: current.marketRevision || 0,
  };
}
export function getSnapshot(
  state: InvestmentState,
  scope: InvestmentScope = {}
): InvestmentSnapshot {
  const date = scope.date || investmentToday();
  dateValue(date);
  const book = ledger(state, date),
    accounts = selectedAccounts(state, scope),
    ids = new Set(accounts.map((a) => a.id));
  if (scope.accountId && !ids.has(scope.accountId))
    return fail('Conta não encontrada neste escopo.');
  if (scope.portfolioId && !state.portfolios.some((p) => p.id === scope.portfolioId))
    return fail('Carteira não encontrada.');
  let cash = 0n,
    income = 0n,
    fees = 0n,
    realized: bigint | null = 0n,
    cost: bigint | null = 0n,
    market = 0n,
    unknownPrice = false,
    unrealized: bigint | null = 0n;
  const issues: string[] = [],
    positions: InvestmentPosition[] = [];
  const cashBaseline = new Set(
    ordered(state, date)
      .filter((o) => o.type === 'OPEN_CASH' || o.type === 'CASH_IN')
      .map((o) => o.accountId)
  );
  const cashComplete = [...ids].every((id) => cashBaseline.has(id));
  for (const account of accounts)
    if (!cashBaseline.has(account.id))
      issues.push(`${account.name}: informe o caixa inicial, mesmo que seja zero.`);
  for (const id of ids) {
    const a = book.accounts.get(id)!;
    cash += a.cash;
    income += a.income;
    fees += a.fees;
    realized = realized === null || a.realized === null ? null : realized + a.realized;
  }
  for (const pos of book.positions.values()) {
    if (!ids.has(pos.accountId) || pos.quantity === 0n) continue;
    const quote = quoteAt(state, pos.assetId, date),
      quality = !quote ? 'missing' : quote.date === date ? 'current' : 'stale';
    const value = quote ? multiply(pos.quantity, decimal(quote.price)) : null;
    if (value === null) {
      unknownPrice = true;
      unrealized = null;
      issues.push(
        `${state.assets.find((a) => a.id === pos.assetId)?.symbol}: informe uma cotação manual com data e origem.`
      );
    } else market += value;
    if (quality === 'stale') {
      unknownPrice = true;
      issues.push(
        `${state.assets.find((a) => a.id === pos.assetId)?.symbol}: último preço conhecido de ${quote!.date}; valor estimado.`
      );
    }
    if (pos.cost === null) {
      cost = null;
      unrealized = null;
      issues.push(
        `${state.assets.find((a) => a.id === pos.assetId)?.symbol}: custo inicial não informado.`
      );
    } else {
      if (cost !== null) cost += pos.cost;
      if (unrealized !== null && value !== null) unrealized += value - pos.cost;
    }
    positions.push({
      accountId: pos.accountId,
      assetId: pos.assetId,
      quantity: textDecimal(pos.quantity),
      cost: pos.cost === null ? null : textDecimal(pos.cost),
      averagePrice:
        pos.cost === null ? null : textDecimal(divideRound(pos.cost * SCALE, pos.quantity)),
      marketValue: value === null ? null : textDecimal(value),
      unrealized: value === null || pos.cost === null ? null : textDecimal(value - pos.cost),
      realized: pos.realized === null ? null : textDecimal(pos.realized),
      income: textDecimal(pos.income),
      quality,
      ...(quote
        ? {
            quoteDate: quote.date,
            quoteSource: quote.source,
            quoteOrigin: quote.origin || 'manual',
            marketTimestamp: quote.marketTimestamp,
            fetchedAt: quote.fetchedAt,
            price: quote.price,
          }
        : {}),
    });
  }
  return {
    date,
    cash: textDecimal(cash),
    cashComplete,
    knownValue: textDecimal(cash + market),
    totalValue: unknownPrice || !cashComplete ? null : textDecimal(cash + market),
    cost: cost === null ? null : textDecimal(cost),
    realized: realized === null ? null : textDecimal(realized),
    unrealized: unrealized === null ? null : textDecimal(unrealized),
    income: textDecimal(income),
    fees: textDecimal(fees),
    positions,
    issues: [...new Set(issues)],
    accounts: accounts.map((a) => ({
      accountId: a.id,
      cash: textDecimal(book.accounts.get(a.id)!.cash),
      complete: cashBaseline.has(a.id),
    })),
  };
}

export function operationTotal(op: OperationInput): string {
  if (op.type === 'BUY' || op.type === 'SELL') {
    const gross = multiply(decimal(op.quantity), decimal(op.unitPrice));
    return textDecimal(
      op.type === 'BUY' ? gross + decimal(op.fees || '0') : gross - decimal(op.fees || '0')
    );
  }
  if (op.type === 'INCOME') return textDecimal(decimal(op.gross) - decimal(op.withholding));
  if (has(op.amount)) return op.amount!;
  return '0';
}

export function calculatePerformance(
  state: InvestmentState,
  scope: { from: string; to: string; portfolioId?: string; accountId?: string }
): InvestmentPerformance {
  const base = {
    returnRate: null,
    gain: null,
    sensitive: false,
    method: 'Modified Dietz' as const,
    from: scope.from,
    to: scope.to,
  };
  const startDate = dateValue(scope.from),
    endDate = dateValue(scope.to),
    days = BigInt(Math.round((endDate - startDate) / 86_400_000));
  if (scope.to > investmentToday())
    return { ...base, reason: 'A data final não pode estar no futuro.' };
  if (days <= 0n)
    return {
      ...base,
      reason: 'Escolha fechamentos em datas diferentes, com início anterior ao fim.',
    };
  const accounts = selectedAccounts(state, scope),
    ids = new Set(accounts.map((a) => a.id));
  if (!accounts.length)
    return { ...base, reason: 'Cadastre uma carteira e uma conta antes de calcular o período.' };
  const ops = ordered(state, scope.to);
  for (const account of accounts) {
    const first = ops.find(
      (o) => o.accountId === account.id && (o.type === 'OPEN_CASH' || o.type === 'CASH_IN')
    );
    if (!first || first.date > scope.from)
      return {
        ...base,
        reason: `Defina um fechamento inicial após a abertura do caixa de ${account.name}.`,
      };
  }
  const opening = ops.find(
    (o) =>
      ids.has(o.accountId) && ['OPEN_CASH', 'OPEN_POSITION'].includes(o.type) && o.date > scope.from
  );
  if (opening)
    return {
      ...base,
      reason:
        'Há uma posição ou caixa inicial dentro do intervalo. Escolha o início após essa abertura.',
    };
  const first = getSnapshot(state, { ...scope, date: scope.from }),
    last = getSnapshot(state, { ...scope, date: scope.to });
  if (first.totalValue === null || last.totalValue === null)
    return {
      ...base,
      reason:
        'São necessários caixa conciliado e preços manuais das duas datas de fechamento para todos os ativos.',
    };
  const v0 = decimal(first.totalValue),
    v1 = decimal(last.totalValue);
  let flows = 0n,
    weightedNumerator = 0n,
    sensitive = false;
  const dailyFlows = new Map<string, bigint>();
  for (const op of ops.filter((o) => o.date > scope.from)) {
    const sourceInside = ids.has(op.accountId),
      destinationInside = !!op.counterAccountId && ids.has(op.counterAccountId);
    let flow = 0n;
    if (sourceInside && op.type === 'CASH_IN') flow = decimal(op.amount);
    if (sourceInside && op.type === 'CASH_OUT') flow = -decimal(op.amount);
    if (
      (op.type === 'TRANSFER_CASH' || op.type === 'TRANSFER_ASSET') &&
      sourceInside !== destinationInside
    ) {
      let value = 0n;
      if (op.type === 'TRANSFER_CASH') value = decimal(op.amount);
      else {
        const q = quoteAt(state, op.assetId!, op.date);
        if (!q || q.date !== op.date)
          return {
            ...base,
            reason: 'A transferência de ativo entre escopos exige preço manual na data efetiva.',
          };
        value = multiply(decimal(op.quantity), decimal(q.price));
      }
      flow = sourceInside ? -value : value;
    }
    flows += flow;
    const elapsed = BigInt(Math.round((dateValue(op.date) - startDate) / 86_400_000));
    weightedNumerator += flow * (days - elapsed);
    dailyFlows.set(op.date, (dailyFlows.get(op.date) || 0n) + (flow < 0n ? -flow : flow));
  }
  for (const flow of dailyFlows.values()) if (flow > 0n && flow * 4n >= v0) sensitive = true;
  const denominatorNumerator = v0 * days + weightedNumerator,
    gain = v1 - v0 - flows;
  if (denominatorNumerator <= 0n)
    return {
      ...base,
      gain: textDecimal(gain),
      sensitive,
      reason: 'O capital ponderado é nulo ou negativo. Ainda não há período calculável.',
    };
  return {
    ...base,
    returnRate: textDecimal(divideRound(gain * days * SCALE, denominatorNumerator)),
    gain: textDecimal(gain),
    sensitive,
    startValue: textDecimal(v0),
    endValue: textDecimal(v1),
    externalFlows: textDecimal(flows),
    denominator: textDecimal(divideRound(denominatorNumerator, days)),
  };
}

export const INVESTMENT_CSV_COLUMNS = [
  'schema_version',
  'source_id',
  'event_id',
  'portfolio_id',
  'account_id',
  'event_type',
  'event_date',
  'sequence',
  'currency',
  'asset_id',
  'quantity',
  'unit_price',
  'fees',
  'amount',
  'gross',
  'withholding',
  'initial_basis',
  'counter_account_id',
  'transfer_group_id',
  'ratio_numerator',
  'ratio_denominator',
  'note',
] as const;
export type InvestmentCSVRow = {
  line: number;
  input: OperationInput;
  status: 'new' | 'duplicate';
  operationId?: string;
};
export type InvestmentCSVPreview = {
  text: string;
  baseRevision: number;
  rows: InvestmentCSVRow[];
  errors: { line: number; message: string }[];
  warnings: string[];
  added: number;
  duplicates: number;
  valid: boolean;
};
const csvFields = {
  asset_id: 'assetId',
  quantity: 'quantity',
  unit_price: 'unitPrice',
  fees: 'fees',
  amount: 'amount',
  gross: 'gross',
  withholding: 'withholding',
  initial_basis: 'initialBasis',
  counter_account_id: 'counterAccountId',
  transfer_group_id: 'transferGroupId',
  ratio_numerator: 'ratioNumerator',
  ratio_denominator: 'ratioDenominator',
  note: 'note',
} as const;
function csvCells(line: string): string[] {
  const values: string[] = [];
  let value = '',
    quoted = false,
    endedQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          value += '"';
          i++;
        } else {
          quoted = false;
          endedQuote = true;
        }
      } else value += c;
    } else if (c === ';') {
      values.push(value);
      value = '';
      endedQuote = false;
    } else if (c === '"' && !value && !endedQuote) quoted = true;
    else {
      if (c === '"' || endedQuote) return fail('Aspas inválidas no CSV.');
      value += c;
    }
  }
  if (quoted)
    return fail('Campo entre aspas incompleto. Quebras de linha dentro de campos não são aceitas.');
  values.push(value);
  return values;
}
function csvEscape(value: string) {
  return /[;"\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}
function replayFingerprint(op: InvestmentOperation, sourceId: string, externalId: string) {
  return op.importFingerprint || fingerprint({ ...op, sourceId, externalId });
}
function similarFingerprint(op: OperationInput) {
  const { sourceId: _source, externalId: _external, note: _note, ...economic } = operationData(op);
  return JSON.stringify(economic);
}
function previewCandidate(state: InvestmentState, rows: InvestmentCSVRow[]): InvestmentState {
  const now = new Date().toISOString();
  return changed(state, {
    operations: [
      ...state.operations,
      ...rows
        .filter((r) => r.status === 'new')
        .map((r) => ({
          ...r.input,
          id: uniqueId(),
          revision: 1,
          status: 'confirmed' as const,
          createdAt: now,
          updatedAt: now,
          history: [],
          importFingerprint: fingerprint(r.input),
        })),
    ],
  });
}
export function previewInvestmentCSV(state: InvestmentState, text: string): InvestmentCSVPreview {
  const preview: InvestmentCSVPreview = {
    text,
    baseRevision: state.revision,
    rows: [],
    errors: [],
    warnings: [],
    added: 0,
    duplicates: 0,
    valid: false,
  };
  if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength > 10 * 1024 * 1024) {
    preview.errors.push({ line: 0, message: 'O arquivo deve ter no máximo 10 MiB.' });
    return preview;
  }
  const lines = text
    .replace(/^\uFEFF/, '')
    .replaceAll('\r\n', '\n')
    .split('\n');
  while (lines.at(-1) === '') lines.pop();
  if (lines.length < 2) {
    preview.errors.push({ line: 1, message: 'Inclua o cabeçalho e ao menos uma movimentação.' });
    return preview;
  }
  if (lines.length > 10001) {
    preview.errors.push({ line: 0, message: 'O limite é de 10.000 movimentações por arquivo.' });
    return preview;
  }
  let header: string[];
  try {
    header = csvCells(lines[0]!);
  } catch (error) {
    preview.errors.push({ line: 1, message: (error as Error).message });
    return preview;
  }
  if (header.join(';') !== INVESTMENT_CSV_COLUMNS.join(';')) {
    preview.errors.push({
      line: 1,
      message: 'Use o cabeçalho completo e na ordem do modelo astra-investments-v1.',
    });
    return preview;
  }
  const seen = new Map<string, string>();
  const similar = new Set(
    state.operations.filter((o) => o.status === 'confirmed').map(similarFingerprint)
  );
  const externalIndex = new Map(
    state.operations.filter((o) => o.sourceId).map((o) => [`${o.sourceId}|${o.externalId}`, o])
  );
  const manualIndex = new Map(state.operations.filter((o) => !o.sourceId).map((o) => [o.id, o]));
  for (let i = 1; i < lines.length; i++) {
    const line = i + 1;
    try {
      if (!lines[i] || lines[i]!.length > 2000 || /\r/.test(lines[i]!))
        returnLineError('Linha vazia, muito longa ou com quebra inválida.');
      const cells = csvCells(lines[i]!);
      if (cells.length !== INVESTMENT_CSV_COLUMNS.length)
        returnLineError('Quantidade de colunas diferente do modelo.');
      const row = Object.fromEntries(header.map((h, j) => [h, cells[j]!])) as Record<
        string,
        string
      >;
      if (row.schema_version !== 'astra-investments-v1' || row.currency !== 'BRL')
        returnLineError('Use schema_version astra-investments-v1 e currency BRL.');
      if (!row.source_id || !row.event_id)
        returnLineError('source_id e event_id são obrigatórios e devem ser estáveis.');
      if (!/^\d{1,7}$/.test(row.sequence!))
        returnLineError('sequence deve ser um inteiro positivo.');
      const account = state.accounts.find((a) => a.id === row.account_id);
      if (!account || account.portfolioId !== row.portfolio_id)
        returnLineError('Conta e carteira não correspondem a este espaço.');
      const input: OperationInput = {
        accountId: row.account_id!,
        type: row.event_type as OperationType,
        date: row.event_date!,
        sequence: Number(row.sequence),
        sourceId: row.source_id,
        externalId: row.event_id,
      };
      for (const [column, field] of Object.entries(csvFields) as [
        keyof typeof csvFields,
        (typeof csvFields)[keyof typeof csvFields],
      ][])
        if (has(row[column])) input[field] = row[column];
      if (input.note?.startsWith("'")) input.note = input.note.slice(1);
      if (
        (input.type === 'TRANSFER_CASH' || input.type === 'TRANSFER_ASSET') &&
        !input.transferGroupId
      )
        returnLineError('transfer_group_id é obrigatório para transferência.');
      const normalized = normalize(state, input),
        key = `${normalized.sourceId}|${normalized.externalId}`,
        fp = fingerprint(normalized),
        previous = seen.get(key),
        duplicate =
          externalIndex.get(key) ||
          (normalized.sourceId === 'astra-manual'
            ? manualIndex.get(normalized.externalId!)
            : undefined);
      if (previous && previous !== fp)
        returnLineError('O mesmo event_id aparece com dados diferentes dentro do arquivo.');
      if (
        duplicate &&
        replayFingerprint(duplicate, normalized.sourceId!, normalized.externalId!) !== fp
      )
        returnLineError(
          'event_id já utilizado com conteúdo diferente. Corrija o registro pelo dashboard.'
        );
      const status = previous || duplicate ? 'duplicate' : 'new';
      preview.rows.push({ line, input: normalized, status, operationId: duplicate?.id });
      seen.set(key, fp);
      if (status === 'new' && similar.has(similarFingerprint(normalized)))
        preview.warnings.push(
          `Linha ${line}: há uma operação semelhante com outro ID. Ambas serão preservadas.`
        );
      similar.add(similarFingerprint(normalized));
    } catch (error) {
      preview.errors.push({ line, message: (error as Error).message });
    }
  }
  preview.added = preview.rows.filter((r) => r.status === 'new').length;
  preview.duplicates = preview.rows.length - preview.added;
  if (!preview.errors.length) {
    try {
      ledger(previewCandidate(state, preview.rows));
    } catch (error) {
      preview.errors.push({ line: 0, message: `Validação do livro: ${(error as Error).message}` });
    }
  }
  preview.valid = !preview.errors.length;
  if (preview.rows.some((r) => r.input.type === 'SPLIT'))
    preview.warnings.push(
      'Desdobramentos ou grupamentos: confirme a razão e a data em uma fonte confiável antes de importar. Frações não são arredondadas.'
    );
  return preview;
}
function returnLineError(message: string): never {
  return fail(message);
}
export function commitInvestmentCSV(
  state: InvestmentState,
  preview: InvestmentCSVPreview
): InvestmentState {
  if (preview.baseRevision !== state.revision)
    return fail('Os registros mudaram desde a prévia. Gere a prévia novamente.');
  const verified = previewInvestmentCSV(state, preview.text);
  if (!verified.valid)
    return fail(
      verified.errors.map((e) => `${e.line ? `Linha ${e.line}: ` : ''}${e.message}`).join(' ')
    );
  if (!verified.added) return state;
  const candidate = previewCandidate(state, verified.rows);
  ledger(candidate);
  return candidate;
}
function exportRow(
  state: InvestmentState,
  op: OperationInput,
  sourceId: string,
  eventId: string
): string {
  const record: Record<string, string> = {
    schema_version: 'astra-investments-v1',
    source_id: sourceId,
    event_id: eventId,
    portfolio_id: state.accounts.find((a) => a.id === op.accountId)?.portfolioId || '',
    account_id: op.accountId,
    event_type: op.type,
    event_date: op.date,
    sequence: String(op.sequence),
    currency: 'BRL',
  };
  for (const [column, field] of Object.entries(csvFields))
    record[column] = (op[field as keyof OperationInput] || '').toString();
  if (op.type === 'TRANSFER_CASH' || op.type === 'TRANSFER_ASSET')
    record.transfer_group_id ||= `transfer-${eventId}`;
  // Prefix every note as spreadsheet text; the importer removes exactly one prefix.
  if (record.note) record.note = `'${record.note}`;
  return INVESTMENT_CSV_COLUMNS.map((c) => csvEscape(record[c] || '')).join(';');
}
export function exportInvestmentCSV(state: InvestmentState): string {
  return (
    '\uFEFF' +
    [
      INVESTMENT_CSV_COLUMNS.join(';'),
      ...ordered(state).map((op) =>
        exportRow(state, op, op.sourceId || 'astra-manual', op.externalId || op.id)
      ),
    ].join('\r\n')
  );
}
export function investmentCSVTemplate(state?: InvestmentState): string {
  const base = INVESTMENT_CSV_COLUMNS.join(';');
  if (!state?.accounts.length) return '\uFEFF' + base + '\r\n';
  const account = state.accounts[0]!,
    date = investmentToday();
  const seq =
    state.operations
      .filter((o) => o.status === 'confirmed' && o.accountId === account.id && o.date === date)
      .reduce((max, o) => Math.max(max, o.sequence), 0) + 1;
  return (
    '\uFEFF' +
    base +
    '\r\n' +
    exportRow(
      state,
      { accountId: account.id, type: 'CASH_IN', date, sequence: seq, amount: '100' },
      'minha-planilha',
      'aporte-exemplo-001'
    ) +
    '\r\n'
  );
}

/** Validate and rebuild a backup; never trust a parsed object as an authorized ledger. */
export function validateInvestmentState(value: unknown): InvestmentState {
  if (!value || typeof value !== 'object') return fail('Backup de investimentos inválido.');
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1 || !Number.isSafeInteger(raw.revision) || (raw.revision as number) < 0)
    return fail('Versão ou revisão de backup inválida.');
  for (const field of ['portfolios', 'accounts', 'assets', 'operations', 'quotes'])
    if (!Array.isArray(raw[field])) return fail('Backup incompleto.');
  const r = raw as unknown as InvestmentState;
  if (
    r.portfolios.length > 100 ||
    r.accounts.length > 500 ||
    r.assets.length > 10000 ||
    r.operations.length > 100000 ||
    r.quotes.length > 200000
  )
    return fail('O arquivo excede os limites de investimentos.');
  let state = emptyInvestmentState();
  for (const p of r.portfolios) state = addPortfolio(state, p);
  for (const a of r.accounts) state = addAccount(state, a);
  for (const a of r.assets) state = addAsset(state, a);
  const seen = new Set<string>(),
    external = new Set<string>();
  const operations: InvestmentOperation[] = [];
  for (const op of r.operations) {
    if (
      !op ||
      !['confirmed', 'cancelled'].includes(op.status) ||
      !Number.isSafeInteger(op.revision) ||
      op.revision < 1 ||
      !Array.isArray(op.history) ||
      op.history.length > 10000
    )
      return fail('Movimentação inválida no backup.');
    const id = uniqueId(op.id);
    if (seen.has(id)) return fail('Há identificadores duplicados no backup.');
    seen.add(id);
    const normalized = normalize(state, op),
      ek = normalized.sourceId ? `${normalized.sourceId}|${normalized.externalId}` : undefined;
    if (ek && external.has(ek)) return fail('Há identidades externas duplicadas no backup.');
    if (ek) external.add(ek);
    const createdAt = timestamp(op.createdAt),
      updatedAt = timestamp(op.updatedAt);
    const history: OperationVersion[] = op.history.map((h) => {
      if (
        !Number.isSafeInteger(h.revision) ||
        h.revision < 1 ||
        h.revision >= op.revision ||
        !['confirmed', 'cancelled'].includes(h.status)
      )
        return fail('Histórico de revisão inválido.');
      return {
        revision: h.revision,
        changedAt: timestamp(h.changedAt),
        reason: nameValue(h.reason, 'Motivo'),
        data: normalize(state, h.data),
        status: h.status,
      };
    });
    if (
      op.importFingerprint &&
      (typeof op.importFingerprint !== 'string' || op.importFingerprint.length > 2000)
    )
      return fail('Identidade de importação inválida.');
    operations.push({
      ...normalized,
      id,
      revision: op.revision,
      status: op.status,
      createdAt,
      updatedAt,
      history,
      ...(op.importFingerprint ? { importFingerprint: op.importFingerprint } : {}),
    });
  }
  state = { ...state, operations };
  ledger(state);
  const quoteIds = new Set<string>(),
    quoteKeys = new Set<string>();
  for (const quote of r.quotes) {
    if (!quote || !Array.isArray(quote.history || []) || (quote.history?.length || 0) > 10000)
      return fail('Cotação inválida no backup.');
    const id = uniqueId(quote.id),
      key = `${quote.assetId}|${quote.date}|${quote.origin || 'manual'}`;
    if (quoteIds.has(id) || quoteKeys.has(key))
      return fail('Há cotações duplicadas para a mesma origem e data.');
    quoteIds.add(id);
    quoteKeys.add(key);
    const normalized = validateQuoteObservation(state, quote, quote.assetId, quote.date);
    state.quotes.push({
      ...normalized,
      id,
      assetId: quote.assetId,
      date: quote.date,
      history: (quote.history || []).map((h) =>
        validateQuoteObservation(state, h, quote.assetId, quote.date)
      ),
    });
  }
  if (r.marketGaps !== undefined && (!Array.isArray(r.marketGaps) || r.marketGaps.length > 200000))
    return fail('Lacunas de histórico inválidas.');
  const gapKeys = new Set<string>();
  state.marketGaps = (r.marketGaps || []).map((gap) => {
    const asset = state.assets.find((a) => a.id === gap.assetId),
      key = `${gap.assetId}|${gap.date}`;
    if (!asset || gap.source !== 'BRAPI' || gapKeys.has(key))
      return fail('Identidade de lacuna inválida.');
    verifiedIdentity(asset.marketIdentity, asset.symbol, asset.kind);
    gapKeys.add(key);
    dateValue(gap.date);
    const fetchedAt = marketTime(gap.fetchedAt, 'Consulta do histórico'),
      barTimestamp = timestamp(gap.barTimestamp);
    if (
      sourceDate(barTimestamp) !== gap.date ||
      gap.date > sourceDate(fetchedAt) ||
      !isMarketMidnight(barTimestamp)
    )
      return fail('Data de lacuna ambígua.');
    return { assetId: gap.assetId, date: gap.date, source: 'BRAPI', fetchedAt, barTimestamp };
  });
  if (
    r.marketRevision !== undefined &&
    (!Number.isSafeInteger(r.marketRevision) || r.marketRevision < 0)
  )
    return fail('Revisão de mercado inválida.');
  return { ...state, revision: r.revision, marketRevision: r.marketRevision || 0 };
}
function timestamp(value: unknown): string {
  if (typeof value !== 'string' || value.length > 40 || !Number.isFinite(Date.parse(value)))
    return fail('Data de auditoria inválida.');
  return value;
}
function isMarketMidnight(value: string) {
  return (
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'America/Sao_Paulo',
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date(value)) === '00:00:00'
  );
}
function validateQuoteObservation(
  state: InvestmentState,
  value: QuoteProvenance & { price: string; source: string; recordedAt: string },
  assetId: string,
  date: string
): QuoteProvenance & { price: string; source: string; recordedAt: string } {
  const asset = state.assets.find((a) => a.id === assetId);
  if (!asset) return fail('Ativo da cotação não encontrado.');
  dateValue(date);
  if (date > investmentToday()) return fail('Cotação futura no backup.');
  const result: QuoteProvenance & { price: string; source: string; recordedAt: string } = {
    price: autoQuoteValue(value.price),
    source: nameValue(value.source, 'Origem da cotação'),
    recordedAt: timestamp(value.recordedAt),
    origin: value.origin || 'manual',
  };
  if (result.origin !== 'manual' && result.origin !== 'automatic')
    return fail('Origem de cotação inválida.');
  if (result.origin === 'manual') {
    if (
      value.provider ||
      value.marketTimestamp ||
      value.fetchedAt ||
      value.observationType ||
      value.barTimestamp
    )
      return fail('Uma cotação manual não pode se declarar observação automática.');
    return result;
  }
  verifiedIdentity(asset.marketIdentity, asset.symbol, asset.kind);
  if (value.provider !== 'BRAPI' || value.symbol !== asset.symbol)
    return fail('Identidade ou fonte automática inválida.');
  const fetchedAt = marketTime(value.fetchedAt!, 'Consulta da cotação');
  result.fetchedAt = fetchedAt;
  result.provider = 'BRAPI';
  result.symbol = asset.symbol;
  result.observationType = value.observationType;
  if (value.observationType === 'quote') {
    const marketTimestamp = marketTime(value.marketTimestamp!, 'Horário de mercado');
    if (sourceDate(marketTimestamp) !== date || marketTimestamp > fetchedAt || value.barTimestamp)
      return fail('Horário ou data de cotação incompatível.');
    result.marketTimestamp = marketTimestamp;
  } else if (value.observationType === 'daily-close') {
    const barTimestamp = timestamp(value.barTimestamp);
    if (
      sourceDate(barTimestamp) !== date ||
      !isMarketMidnight(barTimestamp) ||
      date > sourceDate(fetchedAt) ||
      value.marketTimestamp
    )
      return fail('Data de fechamento ambígua.');
    result.barTimestamp = barTimestamp;
  } else return fail('Tipo de observação de mercado inválido.');
  return result;
}
export function exportInvestmentJSON(state: InvestmentState): string {
  return JSON.stringify(
    { format: 'astra-investments-backup-v1', exportedAt: new Date().toISOString(), state },
    null,
    2
  );
}
export function restoreInvestmentJSON(text: string): InvestmentState {
  if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength > 10 * 1024 * 1024)
    return fail('O backup deve ter no máximo 10 MiB.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail('Não foi possível ler este JSON.');
  }
  const wrapper = parsed as { format?: string; state?: unknown };
  if (wrapper?.format !== 'astra-investments-backup-v1')
    return fail('Selecione um backup Astra Investimentos V1.');
  return validateInvestmentState(wrapper.state);
}

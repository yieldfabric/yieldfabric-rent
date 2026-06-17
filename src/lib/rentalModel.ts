/**
 * The rental domain model — a distilled port of the first-party app's
 * `components/rentals/rentalModel.ts`.
 *
 * A "rental" is not a backend entity: it's a PROJECTION over a generic
 * `Deal`'s plan DAG. `buildRentalDraft` goes form → a 4-node `DealPlan`
 * (the write path); `parseRental` reads a persisted plan back into a
 * `RentalModel` (the read path); `deriveSchedulePayments` folds the plan
 * schedule together with live on-chain payment rows into per-leg
 * statuses.
 *
 * The four plan nodes:
 *   create_property      (create_group_account)     — the property account
 *   add_send_policy      (add_data_policy)          — the agent's balance-gated send authority
 *   rent                 (create_composed_contract) — the tenant's monthly rent obligation
 *   accept_rent          (accept_obligation)        — the tenant accepts (escrows the rent legs)
 *
 * Shape notes (verified against the app's persisted plans): on the way
 * IN the obligation + payment_schedule are plain objects; on the way OUT
 * (a stored plan) they may arrive as JSON *strings* — `parseMaybeJson`
 * tolerates both. Obligation amounts are HUMAN decimals; policy
 * bounds/floors are RAW wei.
 */
import { formatAmountOnly, convertBalanceWithDecimals, formatDateOnly } from './format';
import type { Deal, DealPartyInput, DealPlan } from './dealTypes';

// ── Constants ────────────────────────────────────────────────────────

const WEI_DIVISOR = '1000000000000000000'; // 10^18
const TOKEN_DECIMALS = 18;
const PAID_STATUSES = new Set(['COMPLETED', 'PAID']);
const PERIOD_DAYS: Record<string, number> = { daily: 1, weekly: 7, fortnightly: 14 };

/** Default automation check interval (seconds) when a deal doesn't
 *  specify one — mirrors the worker's `DEFAULT_SCAN_SECS`. */
export const DEFAULT_CADENCE_SECONDS = 60;

export type RentFrequency = 'daily' | 'weekly' | 'fortnightly' | 'monthly' | 'custom';

export const FREQUENCY_OPTIONS: Array<{ value: RentFrequency; label: string }> = [
  { value: 'monthly', label: 'Monthly' },
  { value: 'fortnightly', label: 'Fortnightly' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'daily', label: 'Daily' },
  { value: 'custom', label: 'Custom dates' },
];

export const FREQUENCY_PER_LABEL: Record<RentFrequency, string> = {
  daily: '/ day',
  weekly: '/ week',
  fortnightly: '/ fortnight',
  monthly: '/ month',
  custom: '/ payment',
};

/** A rent leg's lifecycle: Scheduled (locked in the vault until its due
 *  instant) → Due (unlocked, ready to collect) → Credited (the property
 *  account collected it as TENANT CREDIT — instantly due until settled
 *  for cash via the exchange flow). "Credited" is NOT "paid": no cash
 *  has moved yet; settlement is where money changes hands. */
export type RentPaymentState = 'credited' | 'due' | 'scheduled';

// ── View-model types ─────────────────────────────────────────────────

export interface RentalPayment {
  /** 1-based position in the schedule. */
  index: number;
  dueDate: string | null;
  /** Raw stored due instant (UTC ISO) — used to match on-chain rows. */
  dueAtIso: string | null;
  amount: string | null;
}

export interface RentalPolicy {
  executors: string[];
  /** Minimum confidential balance the account must hold for the agent to send (human). */
  floor: string | null;
  /** Per-send cap (human). */
  cap: string | null;
  operations: string[];
  policyId: string;
}

export interface RentalModel {
  dealId: string;
  propertyName: string;
  denomination: string | null;
  /** Raw denomination asset id (e.g. "aud-token-asset") — what /balance takes. */
  denominationAssetId: string | null;
  landlordEntityId: string;
  tenantEntityId: string | null;
  agentEntityId: string | null;
  rentAmount: string | null;
  frequency: RentFrequency;
  schedule: RentalPayment[];
  policy: RentalPolicy | null;
  propertyAccountAddress: string | null;
  cadenceSeconds: number | null;
}

export interface NewRentalParams {
  propertyName: string;
  landlordEntityId: string;
  tenantEntityId: string;
  agentEntityId: string;
  /** human decimal, e.g. "1000" — rent per payment. */
  rentAmount: string;
  frequency: RentFrequency;
  /** Number of payments for periodic cadences (ignored for `custom`). */
  payments: number;
  /** Explicit due instants for `custom` (`datetime-local` values). */
  customDates: string[];
  /** First rent due (`datetime-local` value). Ignored for `custom`. */
  startDate: string;
  /** human — agent may only send while the account balance is ≥ this. */
  floorAmount: string;
  /** human — max per single agent transfer. */
  capAmount: string;
  denomination?: string;
  /** Automation worker scan interval (seconds); ≤0 ⇒ worker default. */
  cadenceSeconds: number;
}

export interface RentalDraftInput {
  name: string;
  parties: DealPartyInput[];
  plan: DealPlan;
}

/** Shape of an on-chain payment row (from GET_RENT_SCHEDULE_CONTRACTS). */
export interface RentContractPaymentLike {
  id?: unknown;
  status?: unknown;
  /** Write-timestamp fallback — the `due_date` column is `Utc::now()` at
   *  row creation, NOT the schedule instant. */
  dueDate?: unknown;
  /** The REAL claim/due instant of a scheduled payment leg. */
  unlockReceiver?: unknown;
  payee?: {
    entity?: { id?: string | null } | null;
    wallet?: { id?: string | null } | null;
  } | null;
}

export interface RentContractLike {
  name?: unknown;
  manager?: { id?: string | null } | null;
  parties?: Array<{ entity?: { id?: string | null } | null } | null> | null;
  payments?: RentContractPaymentLike[] | null;
}

export interface ScheduleLegStatus {
  state: RentPaymentState;
  /** Matched on-chain payment row id; `null` when no row matched. */
  paymentId: string | null;
  /** The payee (property account) wallet id — `accept`'s `walletId`. */
  payeeWalletId: string | null;
  /** The payee ENTITY (the property GROUP). Collect runs acting AS it. */
  payeeEntityId: string | null;
}

// ── Low-level helpers ────────────────────────────────────────────────

interface PlanNodeLike {
  step_id?: string;
  task_name?: string;
  inputs?: Record<string, unknown>;
}

function nodes(deal: Pick<Deal, 'plan'>): PlanNodeLike[] {
  const plan = deal.plan as { nodes?: PlanNodeLike[] } | null;
  return Array.isArray(plan?.nodes) ? (plan!.nodes as PlanNodeLike[]) : [];
}

function nodeByTask(deal: Pick<Deal, 'plan'>, task: string): PlanNodeLike | undefined {
  return nodes(deal).find((n) => n.task_name === task);
}

function isStepRef(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith('$step.');
}

function parseMaybeJson<T = unknown>(value: unknown): T | null {
  if (value == null) return null;
  if (typeof value !== 'string') return value as T;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return null;
  }
}

/** First non-empty, non-`$step` string (recursing into arrays). */
function firstString(value: unknown): string | null {
  if (typeof value === 'string') return value && !isStepRef(value) ? value : null;
  if (Array.isArray(value)) {
    for (const v of value) {
      const s = firstString(v);
      if (s) return s;
    }
  }
  return null;
}

/** Parse a due value into epoch ms. Accepts ISO strings and unix
 *  seconds/millis numbers (or numeric strings). `null` on failure. */
function instantMs(v: unknown): number | null {
  if (typeof v === 'number') return v <= 1e12 ? v * 1000 : v;
  if (typeof v === 'string') {
    const s = v.trim();
    if (/^\d+$/.test(s)) {
      const n = Number(s);
      return n <= 1e12 ? n * 1000 : n;
    }
    const t = new Date(s).getTime();
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

// ── Unit conversion (pure string math; no BigInt — ES5 target) ───────

/** human decimal string ("5000", "1200.50") → raw 18-decimal integer string. */
export function humanToWei(human: string): string {
  const cleaned = (human || '0').trim().replace(/,/g, '');
  const [intPart, fracPart = ''] = cleaned.split('.');
  const frac = (fracPart + '0'.repeat(TOKEN_DECIMALS)).slice(0, TOKEN_DECIMALS);
  const combined = `${intPart || '0'}${frac}`.replace(/^0+(?=\d)/, '');
  return combined || '0';
}

export function humanizeDenomination(denom: unknown): string {
  if (typeof denom !== 'string' || !denom.trim()) return '';
  const cleaned = denom.trim().replace(/-(token-asset|token|asset|coin)$/i, '');
  return cleaned.length <= 5 ? cleaned.toUpperCase() : cleaned;
}

function formatHuman(amount: unknown): string | null {
  if (amount == null || isStepRef(amount)) return null;
  const out = formatAmountOnly(amount as string | number);
  return out === '—' ? null : out;
}

/** Raw 18-decimal wei → formatted human (used for policy floor/cap). */
export function formatWei(amount: unknown): string | null {
  if (amount == null || isStepRef(amount)) return null;
  return formatHuman(convertBalanceWithDecimals(amount as string | number, WEI_DIVISOR));
}

/** A vault `/balance` raw integer → display amount using the response's
 *  `decimals` divisor; missing/invalid ⇒ 0. */
export function vaultBalanceToHuman(
  raw: string | null | undefined,
  decimals: string | null | undefined
): string {
  const human = Number(convertBalanceWithDecimals(raw ?? '0', decimals ?? WEI_DIVISOR));
  return formatAmountOnly(Number.isFinite(human) ? human : 0);
}

// ── Date math (local-field stepping; UTC ISO storage) ────────────────

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Instant → `datetime-local` value ("YYYY-MM-DDTHH:mm") in LOCAL time. */
export function toLocalInputValue(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(
    d.getHours()
  )}:${pad2(d.getMinutes())}`;
}

/** Parse a `datetime-local` value as the user's LOCAL wall time. A bare
 *  date means local midnight. Strips any zone suffix from legacy values. */
export function localInputToInstant(s: string): Date {
  const v = s.trim();
  if (!v.includes('T')) return new Date(`${v}T00:00`);
  const noZone = v.replace(/(Z|[+-]\d{2}:?\d{2})$/, '');
  return new Date(noZone);
}

/** Default first-due: local midnight on the 1st of next month. */
export function firstOfNextMonthIso(): string {
  const now = new Date();
  return toLocalInputValue(new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0));
}

function addDaysLocal(d: Date, days: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + days);
  return out;
}

function addMonthsLocal(d: Date, months: number): Date {
  const out = new Date(d);
  out.setMonth(out.getMonth() + months);
  return out;
}

/** UTC-ISO instant → LOCAL date, appending local HH:mm only when not
 *  local midnight (the stored value is UTC; the user sees wall clock). */
export function formatDueDate(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const out = formatDateOnly(value);
  if (out === 'N/A') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return out;
  const hh = d.getHours();
  const mm = d.getMinutes();
  if (hh !== 0 || mm !== 0) return `${out} ${pad2(hh)}:${pad2(mm)}`;
  return out;
}

function generateDueDates(freq: RentFrequency, start: Date, count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const d =
      freq === 'monthly'
        ? addMonthsLocal(start, i)
        : addDaysLocal(start, (PERIOD_DAYS[freq] ?? 30) * i);
    out.push(d.toISOString());
  }
  return out;
}

function inferFrequency(dueDates: Date[]): RentFrequency {
  if (dueDates.length < 2) return 'monthly';
  const diffsDays = dueDates
    .slice(1)
    .map((d, i) => Math.round((d.getTime() - dueDates[i].getTime()) / 86_400_000));
  const allEqual = (n: number) => diffsDays.every((d) => d === n);
  if (allEqual(1)) return 'daily';
  if (allEqual(7)) return 'weekly';
  if (allEqual(14)) return 'fortnightly';
  if (diffsDays.every((d) => d >= 28 && d <= 31)) return 'monthly';
  return 'custom';
}

// ── Cadence (plan.automation) ────────────────────────────────────────

export function planCadenceSeconds(plan: unknown): number | null {
  const raw = (plan as { automation?: { cadence_seconds?: unknown } } | null)?.automation
    ?.cadence_seconds;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

export function formatCadence(seconds: number | null | undefined): string {
  const s =
    typeof seconds === 'number' && seconds > 0 ? Math.floor(seconds) : DEFAULT_CADENCE_SECONDS;
  const plural = (n: number, unit: string) => `every ${n} ${unit}${n === 1 ? '' : 's'}`;
  if (s % 3600 === 0) return plural(s / 3600, 'hour');
  if (s % 60 === 0) return plural(s / 60, 'minute');
  return plural(s, 'second');
}

// ── Predicate + read path ────────────────────────────────────────────

/** A deal is a rental when its plan provisions a group account AND a
 *  data policy. */
export function isRentalDeal(deal: Pick<Deal, 'plan'>): boolean {
  const ns = nodes(deal);
  return (
    ns.some((n) => n.task_name === 'create_group_account') &&
    ns.some((n) => n.task_name === 'add_data_policy')
  );
}

interface ScheduleLike {
  amount?: unknown;
  legs?: Array<{ due_date?: unknown; unlock_receiver?: unknown }>;
}
interface ObligationLike {
  denomination?: unknown;
  obligor?: unknown;
  payment_schedule?: unknown;
  payments?: unknown;
}

/** The rent obligation node — the composed contract that carries the rent
 *  payment schedule. Rental plans (e.g. the first-party app / canonical
 *  template, which this app reads from the SHARED backend) mint a payment-LESS
 *  "agency credential" via an EARLIER `create_composed_contract` (`mint_agency`),
 *  so the FIRST composed contract is the agency credential, NOT the rent.
 *  Selecting the first one left the schedule empty ("No rent payments defined
 *  yet."). Pick the canonical `rent` step, then any composed contract that
 *  declares a payment schedule, and finally fall back to the only/last composed
 *  contract so single-obligation rentals still resolve. */
function rentObligationNode(deal: Pick<Deal, 'plan'>): PlanNodeLike | undefined {
  const composed = nodes(deal).filter((n) => n.task_name === 'create_composed_contract');
  if (composed.length <= 1) return composed[0];
  const byStepId = composed.find((n) => n.step_id === 'rent');
  if (byStepId) return byStepId;
  const withSchedule = composed.find(
    (n) =>
      parseMaybeJson<ScheduleLike>(
        (parseMaybeJson<ObligationLike[]>(n.inputs?.obligations) ?? [])[0]?.payment_schedule
      ) != null
  );
  return withSchedule ?? composed[composed.length - 1];
}

/** Project a persisted rental Deal into the view model. `null` when the
 *  deal isn't a rental. */
export function parseRental(deal: Deal): RentalModel | null {
  if (!isRentalDeal(deal)) return null;

  const propertyNode = nodeByTask(deal, 'create_group_account');
  const policyNode = nodeByTask(deal, 'add_data_policy');
  const rentNode = rentObligationNode(deal);

  const tenantParty = deal.parties.find((p) => p.role.toLowerCase().includes('tenant'));
  const agentParty = deal.parties.find((p) => p.role.toLowerCase().includes('agent'));

  // Rent schedule from the obligation's payment_schedule.
  const obligations = parseMaybeJson<ObligationLike[]>(rentNode?.inputs?.obligations);
  const ob = Array.isArray(obligations) ? obligations[0] : null;
  const schedRaw = parseMaybeJson<ScheduleLike>(ob?.payment_schedule);
  const legs: ScheduleLike['legs'] =
    schedRaw?.legs ?? parseMaybeJson<ScheduleLike['legs']>(ob?.payments) ?? [];
  const rentAmount = formatHuman(schedRaw?.amount);

  const dueInstants: Date[] = [];
  const schedule: RentalPayment[] = (legs ?? []).map((leg, i) => {
    const due = (leg?.due_date ?? leg?.unlock_receiver) as unknown;
    const dueAtIso = typeof due === 'string' ? due : null;
    if (dueAtIso) {
      const d = new Date(dueAtIso);
      if (!Number.isNaN(d.getTime())) dueInstants.push(d);
    }
    return {
      index: i + 1,
      dueDate: formatDueDate(due),
      dueAtIso,
      amount: rentAmount,
    };
  });

  const denominationAssetId =
    firstString(ob?.denomination) ?? firstString(rentNode?.inputs?.denomination);

  // Policy (the agent's balance-gated send authority).
  let policy: RentalPolicy | null = null;
  if (policyNode) {
    const inputs = policyNode.inputs ?? {};
    const reqs = (inputs.requirements as Array<{ source?: number; lo?: unknown }>) ?? [];
    const balanceReq = reqs.find((r) => r?.source === 0) ?? reqs[0];
    const bounds = (inputs.amount_bounds as Array<{ hi?: unknown }>) ?? [];
    policy = {
      executors: ((inputs.executor_accounts as string[]) ?? []).filter(Boolean),
      floor: formatWei(balanceReq?.lo),
      cap: formatWei(bounds[0]?.hi),
      operations: ((inputs.allowed_operations as string[]) ?? ['send']).filter(Boolean),
      policyId: firstString(inputs.policy_id) ?? '1',
    };
  }

  return {
    dealId: deal.id,
    propertyName:
      deal.name || firstString(propertyNode?.inputs?.name) || 'Rental property',
    denomination: denominationAssetId ? humanizeDenomination(denominationAssetId) : null,
    denominationAssetId,
    landlordEntityId: deal.proposerEntityId,
    tenantEntityId:
      tenantParty?.entityId ?? firstString(ob?.obligor) ?? agentParty?.entityId ?? null,
    agentEntityId: agentParty?.entityId ?? policy?.executors[0] ?? null,
    rentAmount,
    frequency: inferFrequency(dueInstants),
    schedule,
    policy,
    propertyAccountAddress: firstString(policyNode?.inputs?.account_address),
    cadenceSeconds: planCadenceSeconds(deal.plan),
  };
}

/** Map each schedule leg to a status by matching it against live
 *  on-chain payment rows (by due instant). "Credited" is inferred from
 *  the absence of an outstanding row ONLY when rental data is loaded —
 *  the safe direction for a money UI. */
export function deriveSchedulePayments(
  model: Pick<RentalModel, 'schedule' | 'tenantEntityId' | 'propertyName'>,
  contracts: ReadonlyArray<RentContractLike>,
  now: Date = new Date()
): ScheduleLegStatus[] {
  const tenant = model.tenantEntityId;
  const wantName = `${model.propertyName} rent`.toLowerCase();

  // Candidate contracts: name match OR tenant is manager / a party.
  const candidates = (contracts ?? []).filter((c) => {
    const name = typeof c.name === 'string' ? c.name.toLowerCase() : '';
    if (name === wantName || name === 'monthly rent') return true;
    if (tenant && c.manager?.id === tenant) return true;
    if (tenant && (c.parties ?? []).some((p) => p?.entity?.id === tenant)) return true;
    return false;
  });

  // Index outstanding payment rows by due instant (prefer unlockReceiver).
  const byDueMs = new Map<number, RentContractPaymentLike & { collected: boolean }>();
  for (const c of candidates) {
    for (const pay of c.payments ?? []) {
      const ms = instantMs(pay.unlockReceiver) ?? instantMs(pay.dueDate);
      if (ms == null) continue;
      const status = String(pay.status ?? '').toUpperCase();
      const collected = PAID_STATUSES.has(status);
      const existing = byDueMs.get(ms);
      // A collected row wins over an outstanding one at the same instant.
      if (!existing || (collected && !existing.collected)) {
        byDueMs.set(ms, { ...pay, collected });
      }
    }
  }

  const nowMs = now.getTime();
  const rentalDataLoaded = model.schedule.some((leg) => {
    const ms = instantMs(leg.dueAtIso);
    return ms != null && byDueMs.has(ms);
  });

  return model.schedule.map((leg) => {
    const dueMs = instantMs(leg.dueAtIso);
    const pastDue = dueMs != null && dueMs <= nowMs;
    const row = dueMs != null ? byDueMs.get(dueMs) : undefined;

    let state: RentPaymentState;
    if (row?.collected) state = 'credited';
    else if (row) state = pastDue ? 'due' : 'scheduled';
    else if (rentalDataLoaded && pastDue) state = 'credited'; // inferred from absence
    else state = pastDue ? 'due' : 'scheduled';

    return {
      state,
      paymentId: row?.id != null ? String(row.id) : null,
      payeeWalletId: row?.payee?.wallet?.id ?? null,
      payeeEntityId: row?.payee?.entity?.id ?? null,
    };
  });
}

// ── Write path: form → DealPlan ──────────────────────────────────────

/** Form params → a `saveDealDraft` input: a 4-node rental `DealPlan`
 *  plus the deal name + counter-signing parties. */
export function buildRentalDraft(p: NewRentalParams): RentalDraftInput {
  const denom = p.denomination?.trim() || 'aud-token-asset';
  const amountClean = (p.rentAmount || '0').replace(/,/g, '').trim() || '0';

  // Due dates + lease end.
  let dueDates: string[];
  let leaseEnd: string;
  if (p.frequency === 'custom') {
    const instants = (p.customDates ?? [])
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => localInputToInstant(s))
      .filter((d) => !Number.isNaN(d.getTime()))
      .sort((a, b) => a.getTime() - b.getTime());
    dueDates = instants.map((d) => d.toISOString());
    const last = instants[instants.length - 1] ?? new Date();
    leaseEnd = addDaysLocal(last, 1).toISOString();
  } else {
    const start = localInputToInstant(p.startDate);
    const count = Math.max(1, Math.floor(p.payments));
    dueDates = generateDueDates(p.frequency, start, count);
    leaseEnd = (p.frequency === 'monthly'
      ? addMonthsLocal(start, count)
      : addDaysLocal(start, (PERIOD_DAYS[p.frequency] ?? 30) * count)
    ).toISOString();
  }

  const paymentCount = Math.max(1, dueDates.length);
  const rentTotal = (Number(amountClean) * paymentCount).toString();

  // A self-managed landlord is recorded only as the policy executor —
  // the proposer can't be listed as a counter-signing party (the server
  // rejects self-deals).
  const selfManaged = !!p.agentEntityId && p.agentEntityId === p.landlordEntityId;
  const parties: DealPartyInput[] = [
    { entityId: p.tenantEntityId, role: 'tenant' },
    ...(selfManaged ? [] : [{ entityId: p.agentEntityId, role: 'agent' }]),
  ];

  const plan: DealPlan = {
    entry_step_ids: ['create_property'],
    nodes: [
      {
        step_id: 'create_property',
        task_name: 'create_group_account',
        inputs: {
          name: p.propertyName,
          group_type: 'custom',
          description: `Property account for ${p.propertyName}.`,
        },
      },
      {
        step_id: 'add_send_policy',
        task_name: 'add_data_policy',
        inputs: {
          // Delegation: register the policy acting AS the group. The
          // deal-flow bridge strips `acting_as_group` and dispatches
          // under a group delegation JWT.
          acting_as_group: '$step.create_property.group_id',
          account_address: '$step.create_property.group_account_address',
          policy_id: '1',
          executor_accounts: [p.agentEntityId],
          required_signers: [p.landlordEntityId],
          min_signatories: 1,
          allowed_operations: ['send'],
          amount_bounds: [{ token: denom, lo: '0', hi: humanToWei(p.capAmount) }],
          requirements: [
            {
              source: 0,
              denomination: denom,
              lo: humanToWei(p.floorAmount),
              hi: '1000000000000000000000000000',
            },
          ],
          expiry: leaseEnd,
          max_use: String(paymentCount * 4),
        },
      },
      {
        step_id: 'rent',
        task_name: 'create_composed_contract',
        inputs: {
          name: `${p.propertyName} Rent`,
          description: 'Monthly rent payable by the tenant to the property account.',
          acting_as_group: '$step.create_property.group_id',
          counterpart: p.tenantEntityId, // ENTITY id, not an address
          obligations: [
            {
              name: 'Monthly Rent',
              denomination: denom,
              obligor: p.tenantEntityId, // the tenant is the PAYER
              notional: rentTotal, // rent_amount * count
              expiry: leaseEnd,
              data: {
                name: 'Monthly Rent',
                description: `Rent for ${p.propertyName}.`,
              },
              payment_schedule: {
                amount: amountClean, // per-leg human amount
                legs: dueDates.map((due_date) => ({ due_date })),
              },
            },
          ],
        },
      },
      {
        step_id: 'accept_rent',
        task_name: 'accept_obligation',
        assignee_override: { kind: 'party', role: 'tenant' },
        inputs: { contract_id: '$step.rent.composed_contract_id' },
      },
    ],
    edges: [
      { from: 'create_property', to: 'add_send_policy', condition: { kind: 'on_success' } },
      { from: 'add_send_policy', to: 'rent', condition: { kind: 'on_success' } },
      { from: 'rent', to: 'accept_rent', condition: { kind: 'on_success' } },
    ],
    ...(p.cadenceSeconds > 0
      ? { automation: { cadence_seconds: Math.floor(p.cadenceSeconds) } }
      : {}),
  };

  return { name: p.propertyName, parties, plan };
}

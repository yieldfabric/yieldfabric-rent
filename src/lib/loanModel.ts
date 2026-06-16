/**
 * The loan domain model — the loan equivalent of `rentalModel.ts`.
 *
 * A loan is a PERIODIC deal (unlike the one-shot rental): the plan carries
 * a `periodic_template` + `cashflow_ref: amortizing_loan` + `deal_terms`,
 * so the platform amortizes each repayment into interest + principal and
 * advances one period at a time. `buildLoanDraft` mirrors the canonical
 * loan template the first-party app ships
 * (`components/deals/templates/_generated/manifest.ts["loan"]`):
 *
 *   deploy_loan_class  (deploy_contract)          — the transferable note class
 *   mint_loan          (create_composed_contract) — the loan note + repayment schedule
 *   disburse           (instant_send)             — the lender disburses principal → borrower
 *   accept_loan        (accept_obligation)        — the borrower accepts → loan active
 *   + cashflow_ref `amortizing_loan` + deal_terms + a per-period sub-DAG
 *     (collect → evaluate cashflow → pay the lender the principal portion)
 *
 * The amortization (interest vs principal per period) is computed
 * client-side here for display; the platform's `amortizing_loan` engine
 * does the authoritative split at runtime.
 */
import { formatAmountOnly } from './format';
import {
  localInputToInstant,
  humanizeDenomination,
  planCadenceSeconds,
  formatDueDate,
} from './rentalModel';
import type { Deal, DealPartyInput, DealPlan } from './dealTypes';

// ── Types ────────────────────────────────────────────────────────────

export interface LoanPeriod {
  /** 1-based period number. */
  index: number;
  dueDate: string | null;
  dueAtIso: string | null;
  /** The level payment for the period (interest + principal). */
  payment: number;
  /** Interest portion (on the opening balance). */
  interest: number;
  /** Principal portion (pays the balance down). */
  principal: number;
  /** Outstanding balance after this period. */
  balance: number;
}

export interface NewLoanParams {
  loanName: string;
  lenderEntityId: string;
  borrowerEntityId: string;
  /** human decimal, e.g. "100000". */
  principal: string;
  /** annual interest rate, percent, e.g. "8". */
  interestPct: string;
  /** number of monthly periods. */
  termMonths: number;
  /** first payment due (`datetime-local` value). */
  startDate: string;
  denomination?: string;
  /** Mint the note into a TRANSFERABLE class (the loan can be sold). */
  refinanceable: boolean;
  cadenceSeconds: number;
}

export interface LoanModel {
  dealId: string;
  loanName: string;
  denomination: string | null;
  denominationAssetId: string | null;
  lenderEntityId: string;
  borrowerEntityId: string | null;
  principal: number | null;
  interestPct: number | null;
  termPeriods: number;
  monthlyPayment: number | null;
  schedule: LoanPeriod[];
  /** The note class is transferable — the creditor position can be sold. */
  transferable: boolean;
  cadenceSeconds: number | null;
}

export interface LoanDraftInput {
  name: string;
  parties: DealPartyInput[];
  plan: DealPlan;
}

// ── Local helpers (small copies kept self-contained) ─────────────────

const PERIOD_DAYS = 30;

function addDaysLocal(d: Date, days: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + days);
  return out;
}

function nodeByTask(plan: unknown, task: string): { inputs?: Record<string, unknown> } | undefined {
  const nodes = (plan as { nodes?: Array<{ task_name?: string; inputs?: Record<string, unknown> }> } | null)
    ?.nodes;
  return Array.isArray(nodes) ? nodes.find((n) => n.task_name === task) : undefined;
}

function parseMaybeJson<T = unknown>(value: unknown): T | null {
  if (value == null) return null;
  if (typeof value !== 'string') return value as T;
  const t = value.trim();
  if (!t) return null;
  try {
    return JSON.parse(t) as T;
  } catch {
    return null;
  }
}

function firstString(value: unknown): string | null {
  if (typeof value === 'string') return value && !value.startsWith('$') ? value : null;
  if (Array.isArray(value)) {
    for (const v of value) {
      const s = firstString(v);
      if (s) return s;
    }
  }
  return null;
}

function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = Number(v.replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// ── Amortization (client-side, for display) ──────────────────────────

/** The level monthly payment for a fully-amortizing loan. `0%` → straight
 *  principal split. */
export function monthlyPayment(principal: number, annualPct: number, n: number): number {
  if (n <= 0) return 0;
  const m = annualPct / 100 / 12;
  if (m === 0) return round2(principal / n);
  const p = (principal * m) / (1 - Math.pow(1 + m, -n));
  return round2(p);
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** The full amortization schedule. Interest accrues on the outstanding
 *  balance; the level payment covers interest first, the remainder pays
 *  down principal. The last period clears any rounding residue. */
export function amortize(
  principal: number,
  annualPct: number,
  n: number,
  startIso: string
): LoanPeriod[] {
  const m = annualPct / 100 / 12;
  const payment = monthlyPayment(principal, annualPct, n);
  const start = startIso ? new Date(startIso) : new Date();
  let balance = principal;
  const out: LoanPeriod[] = [];
  for (let i = 0; i < n; i++) {
    const interest = round2(balance * m);
    let principalPortion = round2(payment - interest);
    let pay = payment;
    if (i === n - 1) {
      // Final period: clear the balance exactly.
      principalPortion = round2(balance);
      pay = round2(balance + interest);
    }
    balance = round2(Math.max(0, balance - principalPortion));
    const due = Number.isNaN(start.getTime()) ? null : addDaysLocal(start, PERIOD_DAYS * i).toISOString();
    out.push({
      index: i + 1,
      dueDate: due ? formatDueDate(due) : null,
      dueAtIso: due,
      payment: pay,
      interest,
      principal: principalPortion,
      balance,
    });
  }
  return out;
}

/** Display a number as a grouped amount. */
export function fmtMoney(n: number | null | undefined): string {
  return n == null ? '—' : formatAmountOnly(n);
}

// ── Predicate + read path ────────────────────────────────────────────

/** A deal is a loan when its plan is periodic with a loan/mortgage cashflow
 *  engine. (Disjoint from `isRentalDeal`, which is one-shot.) */
export function isLoanDeal(deal: Pick<Deal, 'plan'>): boolean {
  const plan = deal.plan as { periodic_template?: unknown; cashflow_ref?: unknown } | null;
  const cf = plan?.cashflow_ref;
  return !!plan?.periodic_template && typeof cf === 'string' && /loan|mortgage/i.test(cf);
}

interface ScheduleLike {
  amount?: unknown;
  legs?: Array<{ due_date?: unknown }>;
}
interface ObligationLike {
  denomination?: unknown;
  obligor?: unknown;
  payment_schedule?: unknown;
}

/** Project a persisted loan Deal into the view model. `null` when not a loan. */
export function parseLoan(deal: Deal): LoanModel | null {
  if (!isLoanDeal(deal)) return null;
  const plan = deal.plan as {
    deal_terms?: Record<string, unknown>;
    periodic_template?: { schedule?: { count?: number; start_at?: string } };
  } | null;

  const mint = nodeByTask(deal.plan, 'create_composed_contract');
  const deploy = nodeByTask(deal.plan, 'deploy_contract');
  const obligations = parseMaybeJson<ObligationLike[]>(mint?.inputs?.obligations);
  const ob = Array.isArray(obligations) ? obligations[0] : null;
  const sched = parseMaybeJson<ScheduleLike>(ob?.payment_schedule);
  const legs = sched?.legs ?? [];

  const terms = plan?.deal_terms ?? {};
  const principal = num(terms.loan_balance);
  const interestPct = num(terms.interest_pct);
  const termPeriods = plan?.periodic_template?.schedule?.count ?? legs.length ?? 0;
  const monthly = num(terms.expected_payment_amount) ?? num(sched?.amount);

  const tenantParty = deal.parties.find((p) => p.role.toLowerCase().includes('borrow'));
  const denominationAssetId = firstString(ob?.denomination);
  const startIso =
    plan?.periodic_template?.schedule?.start_at ??
    (typeof legs[0]?.due_date === 'string' ? (legs[0]!.due_date as string) : '');

  const schedule =
    principal != null && interestPct != null && termPeriods > 0
      ? amortize(principal, interestPct, termPeriods, startIso)
      : [];

  return {
    dealId: deal.id,
    loanName: deal.name || (firstString(mint?.inputs?.name) ?? 'Loan'),
    denomination: denominationAssetId ? humanizeDenomination(denominationAssetId) : null,
    denominationAssetId,
    lenderEntityId: deal.proposerEntityId,
    borrowerEntityId: tenantParty?.entityId ?? firstString(ob?.obligor) ?? null,
    principal,
    interestPct,
    termPeriods,
    monthlyPayment: monthly,
    schedule,
    transferable: !!deploy?.inputs?.transferable,
    cadenceSeconds: planCadenceSeconds(deal.plan),
  };
}

// ── Write path: form → DealPlan ──────────────────────────────────────

/** Form params → a `saveDealDraft` input: the periodic loan `DealPlan`
 *  (mirrors the shipped `manifest["loan"].plan`, parameterised). */
export function buildLoanDraft(p: NewLoanParams): LoanDraftInput {
  const denom = p.denomination?.trim() || 'aud-token-asset';
  const principal = Number((p.principal || '0').replace(/,/g, '')) || 0;
  const ratePct = Number((p.interestPct || '0').replace(/,/g, '')) || 0;
  const n = Math.max(1, Math.floor(p.termMonths));
  const start = localInputToInstant(p.startDate);
  const dueDates = Array.from({ length: n }, (_, i) => addDaysLocal(start, PERIOD_DAYS * i).toISOString());
  const maturity = addDaysLocal(start, PERIOD_DAYS * n).toISOString();
  const payment = monthlyPayment(principal, ratePct, n);

  const parties: DealPartyInput[] = [{ entityId: p.borrowerEntityId, role: 'borrower' }];

  const plan: DealPlan = {
    entry_step_ids: ['deploy_loan_class'],
    cashflow_ref: 'amortizing_loan',
    deal_terms: {
      loan_balance: principal,
      interest_pct: ratePct,
      expected_payment_amount: payment,
      arrears: 0,
    },
    nodes: [
      {
        step_id: 'deploy_loan_class',
        task_name: 'deploy_contract',
        inputs: {
          name: `${p.loanName} note class`,
          symbol: 'LOAN',
          open_minting: false,
          // Transferable ⇒ the loan note (the creditor position) can be sold.
          transferable: p.refinanceable,
        },
      },
      {
        step_id: 'mint_loan',
        task_name: 'create_composed_contract',
        inputs: {
          // counterpart is the borrower ENTITY — the resolver looks up its
          // wallet. Do NOT pass an empty counterpart_wallet_id: the composed
          // resolver treats Some("") as a real (empty) wallet id and fails
          // with "Wallet  not found" instead of falling back to the entity.
          name: p.loanName,
          counterpart: p.borrowerEntityId, // entity id, never a 0x… address
          obligation_address: '$step.deploy_loan_class.obligation_address',
          obligations: [
            {
              name: `${n}-period term loan`,
              denomination: denom,
              obligor: p.borrowerEntityId, // the borrower owes the repayments
              expiry: maturity,
              payment_schedule: {
                amount: payment, // the level repayment per period
                legs: dueDates.map((due_date) => ({ due_date, linear_vesting: false })),
              },
            },
          ],
        },
      },
      {
        step_id: 'disburse',
        task_name: 'instant_send',
        // The lender (proposer) disburses the principal up front to the borrower.
        inputs: { asset_id: denom, amount: principal, destination_id: p.borrowerEntityId },
        assignee_override: { kind: 'proposer' },
      },
      {
        step_id: 'accept_loan',
        task_name: 'accept_obligation',
        inputs: { contract_id: '$step.mint_loan.composed_contract_id' },
        assignee_override: { kind: 'party', role: 'borrower' },
      },
    ],
    edges: [
      { from: 'deploy_loan_class', to: 'mint_loan', condition: { kind: 'on_success' } },
      { from: 'mint_loan', to: 'disburse', condition: { kind: 'on_success' } },
      { from: 'disburse', to: 'accept_loan', condition: { kind: 'on_success' } },
    ],
    periodic_template: {
      schedule: { kind: 'interval', start_at: dueDates[0], interval_days: PERIOD_DAYS, count: n },
      per_period_entry_step_ids: ['service__collect'],
      per_period_actions: [
        {
          step_id: 'service__collect',
          task_name: 'wait_for_payment_completion',
          inputs: { payment_id: '$period.payment_id' },
        },
        {
          step_id: 'service__evaluate',
          task_name: 'evaluate_cashflow',
          // snapshot/inputs are non-empty seeds: start-readiness rejects
          // empty objects, and the periodic pre-pass re-derives the real
          // per-period values from prior outputs. Shapes per the
          // evaluate_cashflow descriptor (LoanStateMachineService).
          inputs: {
            cashflow_ref: 'amortizing_loan',
            snapshot: { loan_balance: String(principal), arrears: '0', interest_pct: String(ratePct) },
            inputs: { payment_amount: String(payment), expected_payment_amount: String(payment) },
            period_index: '$period.index',
          },
        },
        {
          step_id: 'service__pay_lender',
          task_name: 'instant_send',
          inputs: {
            asset_id: denom,
            amount: '$cashflow.principal_transfer',
            destination_id: p.lenderEntityId,
          },
          assignee_override: { kind: 'party', role: 'borrower' },
        },
      ],
      per_period_edges: [
        { from: 'service__collect', to: 'service__evaluate' },
        { from: 'service__evaluate', to: 'service__pay_lender' },
      ],
    },
    ...(p.cadenceSeconds > 0 ? { automation: { cadence_seconds: Math.floor(p.cadenceSeconds) } } : {}),
  };

  return { name: p.loanName, parties, plan };
}

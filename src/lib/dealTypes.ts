/**
 * Minimal client-side typing of the DMS deal-flow surface — a trimmed
 * copy of the first-party app's `types/deal.ts`, covering only what a
 * rental sample touches.
 *
 * IMPORTANT: the `DealPlan` field names below MIRROR THE RUST SERDE
 * SHAPE EXACTLY (snake_case, no `rename_all`). The server parses plans
 * with `serde_json::from_value::<DealPlan>`, so renaming a field here
 * silently breaks the plan. The GraphQL *input* layer around it
 * (`SaveDealDraftInput.parties[].entityId`, …) is camelCase, per
 * Apollo's convention.
 */

/** Lifecycle status of a deal (1:1 with the Rust enum). */
export type DealStatus =
  | 'DRAFT'
  | 'SHARED'
  | 'PROPOSED'
  | 'ACCEPTED'
  | 'COUNTER_OFFERED'
  | 'REJECTED'
  | 'ACTIVE'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'DEFAULTED'
  | 'FAILED_AFTER_PARTIAL_EXECUTION';

/** One counter-signing party. `role` is a user-authored IRI
 *  (`"tenant"`, `"agent"`, …) resolved against the plan's
 *  `assignee_override` specs at activation. */
export interface DealParty {
  readonly entityId: string;
  readonly role: string;
}

export interface DealPartyInput {
  readonly entityId: string;
  readonly role: string;
}

/** Conditional DAG edge predicate (tagged union, snake_case `kind`). */
export type EdgeCondition =
  | { kind: 'on_success' }
  | { kind: 'on_failure' }
  | { kind: 'on_output'; ref_path: string; equals: unknown };

export interface DependencyEdge {
  readonly from: string;
  readonly to: string;
  readonly condition?: EdgeCondition;
}

/** Override of a descriptor's default assignee (mirrors Rust
 *  `PartyRoleSpec`, serde `tag = "kind"`). */
export type PartyRoleSpec =
  | { readonly kind: 'proposer' }
  | { readonly kind: 'party'; readonly role: string }
  | { readonly kind: 'any_party' }
  | { readonly kind: 'all_parties' }
  | { readonly kind: 'named_entity'; readonly entity_id: string }
  | { readonly kind: 'address'; readonly account_address: string };

/** One DAG node — a typed action invocation. `inputs` values are
 *  literals or `$step.X.Y` ref-expressions resolved at runtime. */
export interface DealAction {
  readonly step_id: string;
  readonly task_name: string;
  readonly inputs: Record<string, unknown>;
  readonly assignee_override?: PartyRoleSpec;
}

/** Per-deal automation tuning read by the background worker. */
export interface DealAutomationConfig {
  readonly cadence_seconds?: number;
}

/** How a periodic deal's periods are scheduled (tagged union, snake_case). */
export type PeriodSchedule =
  | { kind: 'dates'; due_dates: string[] }
  | { kind: 'interval'; start_at: string; interval_days: number; count: number };

/** A periodic deal's per-period sub-DAG, re-instantiated each period by the
 *  scheduler. A loan uses this for amortizing repayments; the rental does
 *  not. */
export interface PeriodicTemplate {
  readonly schedule: PeriodSchedule;
  readonly per_period_actions: DealAction[];
  readonly per_period_edges: DependencyEdge[];
  readonly per_period_entry_step_ids: string[];
}

/** Top-level deal plan. Hashed (sha256 over canonical JSON) for
 *  `plan_hash`. The periodic fields drive cashflow-based deals (loans);
 *  they're absent on one-shot deals (rentals). */
export interface DealPlan {
  readonly nodes: DealAction[];
  readonly edges: DependencyEdge[];
  readonly entry_step_ids: string[];
  readonly automation?: DealAutomationConfig;
  /** Registry key (YAML filename) of the cashflow state-machine — e.g.
   *  `amortizing_loan`. Splits each collected payment into interest +
   *  principal. */
  readonly cashflow_ref?: string;
  /** Deal-level seed values for the cashflow engine (loan: `loan_balance`,
   *  `interest_pct`, `expected_payment_amount`, `arrears`). */
  readonly deal_terms?: Record<string, unknown>;
  /** When present, the runtime materialises one DAG fragment per period. */
  readonly periodic_template?: PeriodicTemplate;
}

// ── Periodic lifecycle (dealPeriods / processDealPeriod) ─────────────

/** One row of a periodic deal's runtime ledger. */
export interface DealPeriodView {
  readonly periodIndex: number;
  /** SCHEDULED | PROCESSING | COMPLETED | FAILED. */
  readonly status: string;
  readonly dueAt: string | null;
  readonly workflowId: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly hasRealised: boolean;
}

export interface ProcessDealPeriodResponse {
  readonly success: boolean;
  readonly dealId: string;
  readonly periodIndex: number;
  readonly status: string;
  readonly message: string | null;
}

/** The federated Deal entity (core fields the sample reads). */
export interface Deal {
  readonly id: string;
  readonly kind?: string;
  readonly name: string | null;
  readonly status: DealStatus;
  /** Canonical-JSON of the `DealPlan` (parsed lazily by the model). */
  readonly plan: unknown;
  readonly planHash?: string;
  readonly proposerEntityId: string;
  readonly parties: ReadonlyArray<DealParty>;
  readonly parentDealId?: string | null;
  readonly cashflowRef?: string | null;
  readonly workflowId?: string | null;
  readonly versionAt?: string;
  readonly acceptedAt?: string | null;
  readonly completedAt?: string | null;
  readonly cancelledAt?: string | null;
  readonly deleted?: boolean;
  readonly transactionId?: string;
}

// ── Lifecycle mutation inputs / responses ────────────────────────────

export interface SaveDealDraftInput {
  readonly draftId?: string | null;
  readonly name?: string | null;
  readonly parties?: ReadonlyArray<DealPartyInput> | null;
  readonly plan?: DealPlan | null;
}

export interface DealMutationResponse {
  readonly success: boolean;
  readonly deal: Deal | null;
  readonly message: string | null;
}

/** Per-party auto-pay status. The deal-automation query returns a LIST
 *  — one row per arming party (landlord auto-collect, tenant
 *  auto-settle); filter by `entityId`. */
export interface DealAutomationStatus {
  readonly active: boolean;
  readonly entityId: string;
  readonly role: string | null;
  readonly keyLabel: string | null;
  readonly createdAt: string;
}

export interface SetDealAutomationKeyInput {
  readonly dealId: string;
  readonly apiKey: string;
  readonly keyLabel?: string;
  readonly keyId?: string;
}

/** An in-DAG step awaiting a party's execution. After `activateDeal`, the
 *  DMS auto-runs the steps it holds a capability for; steps assigned to a
 *  party (via the plan's `assignee_override`) become these — the assignee
 *  drives them to completion with `completePartyAction`. */
export interface PendingAction {
  readonly id: string;
  readonly dealId: string;
  readonly workflowId?: string | null;
  /** The plan node this action executes (matches `DealAction.step_id`). */
  readonly stepId: string;
  /** The descriptor the step runs (e.g. `accept_obligation`). */
  readonly descriptorName: string;
  readonly assigneeKind?: string | null;
  /** The entity expected to execute the step. */
  readonly assigneeEntityId?: string | null;
  /** PENDING | IN_PROGRESS | COMPLETED | EXPIRED | CANCELLED. */
  readonly status: string;
  readonly createdAt?: string;
}

export interface PartyActionResponse {
  readonly success: boolean;
  readonly message: string | null;
}

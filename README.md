# YieldFabric Rent — reference implementation

An open-source, minimal-but-real **rental / lease-management app** built
on YieldFabric's **deal-management system (DMS)**. Use it as the starting
point for any app where two or more parties agree terms, sign them, and
then let the platform execute the on-chain consequences on a schedule —
rentals, subscriptions, instalment plans, managed payouts.

The thing that makes this example different from the
[`yieldfabric-quickstart`](../yieldfabric-quickstart/) rental flow: that
one mints a rent obligation **directly** (two calls, no agreement). This
one drives the **full DMS lifecycle** the first-party app's `Rentals`
page uses — a rental is a counter-signed **Deal** carrying a plan, and
the DMS stands up the property account, the managing-agent send policy,
and the rent obligation for you when the deal activates.

```
Browser ── @yieldfabric/wallet ──► auth service     (sign-in, JWT, refresh, group delegation)
        ── DMS deal-flow ────────► federated gateway (dealFlow { saveDealDraft · proposeDraft
                                                      · signDeal · activateDeal · automation }
                                                      + rent-schedule contracts, entities, assets)
        ── money loop ───────────► payments service  (accept · swapObligorPayment · completeSwap
                                                      + balance + message-status polling)
```

## What a "rental" is here

A rental is a **`Deal`** whose `DealPlan` is a 4-node DAG
(`src/lib/rentalModel.ts::buildRentalDraft`):

```
create_property   create_group_account     → the property account (collects rent)
      │ on_success
add_send_policy   add_data_policy           → the managing agent's balance-gated send authority
      │ on_success
rent              create_composed_contract  → the tenant's monthly-rent obligation (the lease)
      │ on_success
accept_rent       accept_obligation         → the tenant accepts (escrows the rent legs)
```

You author that plan, the tenant (and agent) sign it, you activate it —
and the DMS compiles the plan and submits the underlying on-chain work.
After activation the recurring money loop runs against the live contract.

## What you get out of the box

- **Sign-in** via the wallet-SDK (`LoginComponent` + `LoginAltMethods`):
  email/password plus whatever alternative methods your auth service
  advertises (wallet signature, passkey, providers). Session restore,
  refresh, and logout are SDK-owned.
- **Author a rental as a deal plan** — the New-lease form
  (`src/pages/NewLease.tsx`) turns lease terms into the 4-node
  `DealPlan` and saves it as a draft (`dealFlow.saveDealDraft`), with a
  **live JSON preview** of the exact plan the DMS will compile.
- **The deal lifecycle** — propose → sign → activate
  (`src/lib/dealFlow.ts`), driven from the lease detail
  (`src/components/LeaseDetail.tsx`). The controls you see depend on your
  role (landlord = proposer, tenant, or managing agent), derived from
  your entity id.
- **The rent roll** — the schedule is read from the plan; each leg's
  status (**Scheduled → Due → Credited**) is derived from live on-chain
  payment rows (`deriveSchedulePayments` + the `GET_RENT_SCHEDULE_CONTRACTS`
  read). "Credited" is collected-as-tenant-credit, **not** "paid".
- **The money loop** — the landlord **collects** a due leg (`accept`,
  acting as the property group via a delegation JWT), **exchanges** the
  collected credit for a cash swap (`swapObligorPayment`), and the tenant
  **settles** it (`completeSwap`). Cash only moves at settlement.
- **Property-account balance** — cash vs tenant-credit, read with two
  obligor-distinguished `/balance` calls under the group delegation JWT.
- **Two-sided automation** — the landlord arms **auto-collect** and the
  tenant arms **auto-settle**; each stores a scoped `yf_api_…` credential
  (`apiKeysService.generate` → `dealFlow.setDealAutomationKey`) the rent
  worker fires under, so the loop runs unattended.
- **Managing-agent send policy** — the landlord (and a group-member
  agent) see the registered `add_data_policy` (cap, balance floor, uses,
  expiry, approval). The landlord can **approve** it (a personal
  signature over the registered digest, via the SDK generic signer with
  the account-owner key), **add**, **novate** (register an amended
  successor), and **revoke** it; the agent (or landlord) **disburses
  under it** (`executeUnderPolicy`, bounded by the cap + floor on chain).
  See `src/lib/policy.ts` + `src/components/PolicySection.tsx`.
- **Per-role account views** — the landlord/agent see the **property
  account** (cash, tenant credit, incoming, history); the tenant sees
  **their own wallet** (cash, incoming, history). Plus a standalone
  **Wallet** page (`/wallet`).
- **Manual-signature support** — one global `<SignatureWorkflow />` mount
  so external-signer users (MetaMask / passkey) get the signing drawer
  for on-chain steps; email/password users are signed server-side.

## Prerequisites

- Node 18+
- A reachable YieldFabric deployment and a user account on it — the
  **hosted platform** (`auth.yieldfabric.com` · `pay.yieldfabric.com` ·
  `api.yieldfabric.com`), or your own. Copy `.env.example` and point the
  three service URLs at your deployment.
- **SDK resolution is automatic — local source if present, else the
  published packages.** No manual switch:
  - **In the monorepo** (the sibling repos exist at
    `../../yieldfabric-wallet-sdk` and `../../yieldfabric-terminal`), the
    SDKs build from their **live source** — edit `@yieldfabric/wallet`
    and it shows up here with no rebuild.
  - **Standalone** (copy this folder anywhere, no siblings), `npm install`
    pulls `@yieldfabric/*` from the public registry and builds from the
    published dist.

  The detection lives in `craco.config.js` / `tailwind.config.js`
  (presence check) and `tsconfig.json` (two-entry `paths`, src first).
  Force the published path from inside the monorepo with
  `YF_FORCE_REGISTRY=1`.

## Run it

```bash
cp .env.example .env     # point the URLs at your YF deployment
npm install              # monorepo: links local SDK src · standalone: pulls from registry
npm start                # start the dev server
```

Production build: `npm run build`. Type check: `npm run typecheck` (the
build itself doesn't type-check — see `craco.config.js`).

A note on **two roles**: a rental has at least a landlord and a tenant.
To watch the whole loop, propose as yourself, then sign in as the tenant
(another browser / profile) — the proposed lease also appears in the
tenant's incoming inbox via the SDK's `<IncomingPaymentsLauncher>`.

## How it's wired — the files that matter

### 1. `src/lib/rentalModel.ts` — the rental ⇄ deal-plan projection

The whole domain model. `buildRentalDraft(params)` is the write path
(form → 4-node `DealPlan`); `parseRental(deal)` is the read path
(persisted plan → a `RentalModel`); `deriveSchedulePayments(model,
contracts)` folds the plan schedule together with on-chain payment rows
into per-leg statuses. `isRentalDeal(deal)` is how a generic deal is
recognised as a rental (it has both a `create_group_account` and an
`add_data_policy` node). Plan field names are the **exact Rust serde
snake_case** keys — don't rename them.

### 2. `src/lib/dealFlow.ts` — the DMS lifecycle

The deal-flow client: `saveDealDraft` → `proposeDraft` → `signDeal` →
`activateDeal`, then `pendingActionsForDeal` + `completePartyAction` to
**execute the deal's steps to completion** (after activation the DMS
auto-runs the steps it holds a capability for; steps assigned to a party
— the tenant's accept — surface as pending actions the assignee
executes). Plus the automation credential (`setDealAutomationKey` /
`revokeDealAutomationKey`) and `dealsByParty` / `dealAutomationStatus`.
Every call rides the **federated gateway** (`gatewayQuery` /
`gatewayMutation`) because the `dealFlow { … }` namespace lives on the
agents subgraph and is composed by the gateway — the same client the
first-party app uses for it.

### 3. `src/lib/payments.ts` — the on-chain money loop

`collectRentLeg` (`accept`), `exchangeCredit` (`swapObligorPayment`), and
`settleExchange` (`completeSwap`) — the recurring loop after activation.
These submit on-chain work, so they take the **payments-direct** route
(`pay.yieldfabric.com`), and the landlord side runs **acting as the property group**
via a cached delegation JWT (`src/lib/delegation.ts`). Also the reads:
the rent-schedule contracts, the entity directory, and the open-exchange
swaps.

### 4. `src/lib/graphql.ts` — the wire primitives

`gatewayQuery` / `gatewayMutation` (the federated gateway),
`paymentsMutation` (payments-direct), `fetchBalance` + `getMessage` +
`waitForMessage` (REST), and
`freshIdempotencyKey`. Auth is the SDK's — every call reads the current
bearer from `tokenManager`; group-acting calls pass the delegation JWT
explicitly. **On-chain mutations return at enqueue** (a `messageId`);
`waitForMessage` polls the message-status endpoint until `executed`.

### 5. `src/pages/*` — the surfaces

`Overview.tsx` (identity + the wire map + the lessons), `NewLease.tsx`
(author + save the plan, with the live preview), and `Leases.tsx`
(list + the `LeaseDetail` control that holds the lifecycle, rent roll,
money loop, and automation).

## The wire rules

A consumer app talks to these surfaces and nothing else:

| Surface | URL | Rule |
|--|--|--|
| Auth REST | `auth.yieldfabric.com/auth/**`, `/protected/jwt` | Sign-in, refresh, the group-delegation JWT (all SDK-owned), and the identity lookup. Read the current bearer from the SDK's `tokenManager`. |
| Federated gateway | `api.yieldfabric.com/graphql` | The **DMS deal-flow** namespace (`dealFlow { … }`) and cross-service **reads** (rent-schedule contracts, entities, assets). |
| Payments-direct | `pay.yieldfabric.com/graphql` | **On-chain mutations** the DMS doesn't wrap — the money loop: `accept`, `swapObligorPayment`, `completeSwap`. |
| Message status | `pay.yieldfabric.com/api/users/{eid}/messages/{mid}` | Mutations return when the queue **accepts** them, not when they settle. Poll until `executed` (`waitForMessage`). Keyed under the submitting entity (the group, for group-acting calls). |

Two gotchas this app encodes:

- **`counterpart` / `obligor` are entity ids**, never `0x…` addresses.
  The tenant is the rent obligation's obligor (payer) and counterpart.
- **Acting as the property group needs a delegation JWT.** The property
  account, its balance, and its encrypted positions belong to the group
  entity — a plain landlord JWT fails the ownership checks. Collect /
  exchange / balance all run under `groupDelegationJwt(groupId)`.

## Loans — the same pattern, amortizing

The same DMS spine powers a second instrument: a **loan** (the `/loans`
tab). A loan is a *periodic* deal, where a rental is one-shot — so it adds
exactly two things on top of the rental machinery:

- **A cashflow engine.** The plan carries `cashflow_ref: amortizing_loan`
  + `deal_terms` (`loan_balance`, `interest_pct`, `expected_payment_amount`,
  `arrears`) + a per-period sub-DAG (`periodic_template`). Each repayment is
  split into interest (on the outstanding balance) + principal; the platform
  advances one period at a time (`dealPeriods` / `processDealPeriod`).
- **A principal disbursement + a transferable note.** Activation deploys a
  loan-note class (`deploy_contract`, symbol `LOAN`), mints the loan into it
  (`create_composed_contract`, linking the note class via
  `$step.deploy_loan_class.obligation_address`), **disburses the principal**
  (lender → borrower, `instant_send`), and the borrower accepts — a 4-node
  setup DAG. The note is minted into a transferable class when **Sellable**
  is checked, so the creditor position (the note NFT) can be sold. On the
  mint node `counterpart` and `obligor` are the borrower **entity id**, never
  a `0x…` address (the resolver looks up the wallet); don't set an empty
  `counterpart_wallet_id` — the composed resolver treats `Some("")` as a real
  (empty) wallet id and fails instead of falling back to the entity.

The roles are **lender** (proposer; disburses, collects) and **borrower**
(counterparty; accepts, repays). The loan files mirror the rental triad
and reuse the entire `lib/` spine:

| Loan | mirrors | Rental |
|--|--|--|
| `src/lib/loanModel.ts` (`buildLoanDraft` / `parseLoan` / `amortize`) | ⇄ | `src/lib/rentalModel.ts` |
| `src/lib/loanLifecycle.ts` (lender/borrower `nextStep`) | ⇄ | `src/lib/lifecycle.ts` |
| `src/pages/NewLoan.tsx` (terms + live plan + amortization preview) | ⇄ | `src/pages/NewLease.tsx` |
| `src/pages/Loans.tsx` + `src/components/LoanDetail.tsx` | ⇄ | `src/pages/Leases.tsx` + `LeaseDetail.tsx` |

`buildLoanDraft` is a parameterised copy of the canonical loan template
the first-party app ships
(`yieldfabric-app/src/components/deals/templates/_generated/manifest.ts["loan"]`),
backed by the `amortizing_loan` cashflow config. `LoanDetail` shows the
lifecycle stepper + role-aware next step, the **repayment schedule**
(client-side amortization overlaid with the live per-period status, with a
borrower **Repay** that fires `processDealPeriod`), borrower **auto-pay**,
and a note on the sellable loan note.

## Going further

- **Periodic rentals.** A `cashflow_ref` + `periodic_template` on the
  plan turns a rental into a recurring fixed-payment deal the
  `deal_period_scheduler` advances on the wall clock.
- **Drive it conversationally.** The full production rental is also a
  deal template the agents service runs end-to-end
  ([`yieldfabric-economy/examples/general/templates/rental-contract.yaml`](../../yieldfabric-economy/examples/general/templates/rental-contract.yaml),
  exercised by
  [`yieldfabric-docs/scripts/tests/rental_flow_suite.yaml`](../../yieldfabric-docs/scripts/tests/rental_flow_suite.yaml)) —
  ask the AI terminal to *"create a rental contract"*.
- **Sell a loan (serviced model).** This sample repays the lender
  directly. The production model routes repayments into a servicing
  account and lets the **current note-holder** collect under a send policy
  via `executeUnderPolicy` — so transferring the note (selling the loan)
  re-routes future collection to the buyer automatically, no policy
  re-registration (the platform resolves the note's owner live on each
  collect). The unattended driver is `loan_collect_scheduler.rs`; the e2e
  is
  [`yieldfabric-docs/scripts/tests/loan_auto_collect_transfer_suite.yaml`](../../yieldfabric-docs/scripts/tests/loan_auto_collect_transfer_suite.yaml).

## When this isn't enough

- **The minimal two-party version** — the
  [`yieldfabric-quickstart`](../yieldfabric-quickstart/) `RentalDeal.tsx`
  flow mints the rent obligation directly (no DMS), the smallest possible
  rental.
- **Chat / LLM / agent app** — the [`yieldfabric-chat`](../yieldfabric-chat/)
  example is the same stack focused on streaming chat and reasoning.
- **Everything at once** — `yieldfabric-app` is the first-party app these
  patterns are extracted from (`src/pages/Rentals.tsx`).

## Documentation

The app itself is a guided tour: every surface that demonstrates a
platform concept carries a `docs ↗` link to the page explaining it. All
links live in one registry, `src/docs.ts`, overridable via
`REACT_APP_DOCS_BASE_URL`.

- **DMS** (deals, plans, lifecycle): `yieldfabric.com/docs/guides/dms`
- **Deal lifecycle**: `yieldfabric.com/docs/guides/deal-lifecycle`
- **Building with YieldFabric** (the public API surface):
  `yieldfabric.com/docs/guides/building-with-yf`

## License

The example app's own code is MIT — see [LICENSE](./LICENSE).

The two SDK packages it consumes (`@yieldfabric/wallet`,
`@yieldfabric/terminal`) are **licensed separately by YieldFabric** and
are not covered by this MIT grant.

/**
 * The rental lifecycle — one shared model for "where is this lease?" and
 * "what does my role do next?". Both the Overview tutorial and the lease
 * detail read from here so the story is told the same way everywhere.
 *
 * A rental's deal status maps onto four human stages:
 *
 *   Compose  (DRAFT)                        — the landlord writes the terms
 *   Sign-off (SHARED/PROPOSED/ACCEPTED/…)   — the parties review + sign
 *   Live     (ACTIVE)                       — on-chain; the rent runs
 *   Complete (COMPLETED)                    — all rent settled
 *
 * (CANCELLED / REJECTED / DEFAULTED / FAILED collapse to "Closed".)
 */
import type { DealStatus } from './dealTypes';

export type RentalStage = 'draft' | 'signoff' | 'live' | 'complete' | 'closed';
export type RentalRole = 'landlord' | 'tenant' | 'agent' | 'observer';

/** The visible stepper stages, in order. */
export const STAGE_STEPS: Array<{ key: Exclude<RentalStage, 'closed'>; label: string; blurb: string }> = [
  { key: 'draft', label: 'Compose', blurb: 'The landlord writes the lease terms' },
  { key: 'signoff', label: 'Sign-off', blurb: 'The tenant (and agent) review + sign' },
  { key: 'live', label: 'Live', blurb: 'On-chain — the rent runs' },
  { key: 'complete', label: 'Complete', blurb: 'All rent has settled' },
];

export function rentalStage(status: DealStatus): RentalStage {
  switch (status) {
    case 'DRAFT':
      return 'draft';
    case 'SHARED':
    case 'PROPOSED':
    case 'ACCEPTED':
    case 'COUNTER_OFFERED':
      return 'signoff';
    case 'ACTIVE':
      return 'live';
    case 'COMPLETED':
      return 'complete';
    default:
      return 'closed';
  }
}

export const ROLE_LABEL: Record<RentalRole, string> = {
  landlord: 'landlord',
  tenant: 'tenant',
  agent: 'managing agent',
  observer: 'observer',
};

export interface NextStep {
  /** What to do (or wait for) now. */
  title: string;
  /** One or two lines of guidance, naming the section to use. */
  detail: string;
  /** action = you can act now · waiting = waiting on someone else · done. */
  tone: 'action' | 'waiting' | 'done';
}

/** The role-aware "what do I do next?" — the heart of the tutorial. The
 *  dynamic signals (a step assigned to me, a due leg, collected credit, an
 *  open settlement) come from the lease detail, which has them in hand. */
export function nextStep(a: {
  role: RentalRole;
  status: DealStatus;
  myPendingAction?: boolean;
  collectableLeg?: boolean;
  hasCredit?: boolean;
  openExchange?: boolean;
}): NextStep {
  const stage = rentalStage(a.status);
  if (stage === 'closed')
    return {
      title: 'This lease is closed',
      detail: 'It was cancelled or rejected — create a new lease to start again.',
      tone: 'done',
    };
  if (stage === 'complete')
    return { title: 'This lease is complete', detail: 'All rent has settled. Nothing more to do.', tone: 'done' };

  switch (a.role) {
    case 'landlord':
      if (stage === 'draft')
        return {
          title: 'Send the lease for signing',
          detail: 'Propose the draft to the tenant (and agent) — use "Send for signing" in the header. They sign, then you activate.',
          tone: 'action',
        };
      if (stage === 'signoff') {
        if (a.status === 'ACCEPTED')
          return {
            title: 'Activate the lease',
            detail: 'Everyone has signed — hit "Activate" to stand up the property account, the send policy, and the rent obligation on-chain.',
            tone: 'action',
          };
        return {
          title: 'Waiting for the tenant to sign',
          detail: 'The lease is proposed. Once the tenant (and agent) sign, you can activate it.',
          tone: 'waiting',
        };
      }
      // live
      if (a.myPendingAction)
        return {
          title: 'Execute your step',
          detail: 'A deal step is assigned to you — run it under "Deal execution".',
          tone: 'action',
        };
      if (a.collectableLeg)
        return {
          title: 'Collect the rent that’s due',
          detail: 'A rent leg has unlocked — "Collect" it under "Rent schedule". It lands in the property account as tenant credit.',
          tone: 'action',
        };
      if (a.hasCredit)
        return {
          title: 'Exchange the collected credit for cash',
          detail: 'Collected rent is sitting as credit — "Exchange credit → cash" under "Property account balance"; the tenant settles it.',
          tone: 'action',
        };
      return {
        title: 'The rent is running',
        detail: 'Collect rent as it falls due, manage the agent send policy, or arm auto-collect to let the worker do it.',
        tone: 'done',
      };
    case 'tenant':
      if (stage === 'signoff')
        return {
          title: 'Review and sign the lease',
          detail: 'Check the terms and sign — use "Sign" in the header, or accept it from the incoming inbox (top-right).',
          tone: 'action',
        };
      if (a.myPendingAction)
        return {
          title: 'Accept the lease',
          detail: 'Accept the rent obligation to escrow the rent and lock in the schedule — "Execute" it under "Deal execution".',
          tone: 'action',
        };
      if (a.openExchange)
        return {
          title: 'Settle the rent',
          detail: 'The landlord collected rent and requested cash — "Settle & pay" under "Rent settlements".',
          tone: 'action',
        };
      return {
        title: 'You’re all set',
        detail: 'Settle rent when it’s requested, or arm auto-settle so it happens automatically. Check "Your account" for your balance.',
        tone: 'done',
      };
    case 'agent':
      if (stage === 'signoff')
        return {
          title: 'Review and sign the lease',
          detail: 'You’re the managing agent on this lease — review the terms and sign.',
          tone: 'action',
        };
      return {
        title: 'Disburse under the send policy',
        detail: 'Once the landlord has approved the policy, send from the property account within its cap + balance floor — under "Agent send policy".',
        tone: 'action',
      };
    default:
      return {
        title: 'You’re viewing this lease',
        detail: 'You’re not a party to it, so there’s nothing for you to do.',
        tone: 'done',
      };
  }
}

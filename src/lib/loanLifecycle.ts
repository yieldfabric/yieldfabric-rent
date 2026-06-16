/**
 * Loan lifecycle guidance — the loan-worded sibling of `lifecycle.ts`.
 * Reuses the generic stage mapping (`rentalStage`) + stepper, and adds the
 * lender/borrower "what do I do next?" matrix.
 */
import { rentalStage, type NextStep } from './lifecycle';
import type { DealStatus } from './dealTypes';

export type LoanRole = 'lender' | 'borrower' | 'observer';

export const LOAN_ROLE_LABEL: Record<LoanRole, string> = {
  lender: 'lender',
  borrower: 'borrower',
  observer: 'observer',
};

/** The role-aware next step for a loan. Mirrors the rental's `nextStep`,
 *  with loan-specific stages: the lender disburses principal at activation,
 *  the borrower accepts then repays each period. */
export function loanNextStep(a: {
  role: LoanRole;
  status: DealStatus;
  myPendingAction?: boolean;
  duePeriod?: boolean;
  autoPayArmed?: boolean;
}): NextStep {
  const stage = rentalStage(a.status);
  if (stage === 'closed')
    return {
      title: 'This loan is closed',
      detail: 'It was cancelled or rejected — create a new loan to start again.',
      tone: 'done',
    };
  if (stage === 'complete')
    return { title: 'This loan is complete', detail: 'All repayments have settled. Nothing more to do.', tone: 'done' };

  switch (a.role) {
    case 'lender':
      if (stage === 'draft')
        return {
          title: 'Send the loan for signing',
          detail: 'Propose the draft to the borrower — "Send for signing" in the header. They sign, then you activate.',
          tone: 'action',
        };
      if (stage === 'signoff') {
        if (a.status === 'ACCEPTED')
          return {
            title: 'Activate the loan',
            detail: 'The borrower has signed — "Activate" to deploy the note, mint the loan, and disburse the principal. (You must hold the principal to disburse.)',
            tone: 'action',
          };
        return {
          title: 'Waiting for the borrower to sign',
          detail: 'The loan is proposed. Once the borrower signs, you can activate it and disburse the principal.',
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
      return {
        title: 'The loan is being repaid',
        detail: 'Principal is disbursed and the borrower repays each period — the platform pays you the principal portion. Watch the repayment schedule.',
        tone: 'done',
      };
    case 'borrower':
      if (stage === 'signoff')
        return {
          title: 'Review and sign the loan',
          detail: 'Check the principal, rate, and term, then sign — "Sign" in the header, or accept from the incoming inbox (top-right).',
          tone: 'action',
        };
      if (a.myPendingAction)
        return {
          title: 'Accept the loan',
          detail: 'Accept the loan obligation to lock in the repayment schedule — "Execute" it under "Deal execution".',
          tone: 'action',
        };
      if (a.autoPayArmed)
        return {
          title: 'Auto-pay is on',
          detail: 'Your repayments fire automatically each period. You can stop it under "Automation".',
          tone: 'done',
        };
      if (a.duePeriod)
        return {
          title: 'Repay this period',
          detail: 'A repayment period is due — "Repay" it under "Repayment schedule", or arm auto-pay so it happens automatically.',
          tone: 'action',
        };
      return {
        title: 'You’re up to date',
        detail: 'Repay each period as it falls due, or arm auto-pay under "Automation".',
        tone: 'done',
      };
    default:
      return {
        title: 'You’re viewing this loan',
        detail: 'You’re not a party to it, so there’s nothing for you to do.',
        tone: 'done',
      };
  }
}

import React from 'react';
import type { DealStatus } from '../lib/dealTypes';
import type { RentPaymentState } from '../lib/rentalModel';

type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'error';

const TONE: Record<Tone, string> = {
  neutral: 'bg-chip text-ink-soft',
  info: 'bg-status-info-bg text-status-info-text',
  success: 'bg-status-success-bg text-status-success-text',
  warning: 'bg-status-warning-bg text-status-warning-text',
  error: 'bg-status-error-bg text-status-error-text',
};

/** Small rounded pill. */
export function Pill({
  tone = 'neutral',
  children,
  className,
}: {
  tone?: Tone;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${TONE[tone]} ${
        className ?? ''
      }`}
    >
      {children}
    </span>
  );
}

const DEAL_TONE: Record<DealStatus, Tone> = {
  DRAFT: 'neutral',
  SHARED: 'info',
  PROPOSED: 'info',
  ACCEPTED: 'success',
  COUNTER_OFFERED: 'warning',
  REJECTED: 'error',
  ACTIVE: 'success',
  COMPLETED: 'success',
  CANCELLED: 'error',
  DEFAULTED: 'error',
  FAILED_AFTER_PARTIAL_EXECUTION: 'error',
};

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Deal lifecycle status (DRAFT / PROPOSED / ACTIVE / …). */
export function StatusPill({ status }: { status: DealStatus }) {
  return <Pill tone={DEAL_TONE[status] ?? 'neutral'}>{titleCase(status)}</Pill>;
}

const STATE_TONE: Record<RentPaymentState, Tone> = {
  credited: 'success',
  due: 'warning',
  scheduled: 'info',
};
const STATE_LABEL: Record<RentPaymentState, string> = {
  credited: 'Credited',
  due: 'Due',
  scheduled: 'Scheduled',
};

/** A rent leg's state badge. "Credited" ≠ "paid" — see rentalModel. */
export function PaymentStateBadge({ state }: { state: RentPaymentState }) {
  return <Pill tone={STATE_TONE[state]}>{STATE_LABEL[state]}</Pill>;
}

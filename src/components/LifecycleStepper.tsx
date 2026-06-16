import React from 'react';
import { STAGE_STEPS, type RentalStage } from '../lib/lifecycle';

/**
 * The rental lifecycle as a horizontal stepper: Compose → Sign-off → Live
 * → Complete. Gives instant orientation — "where is this lease?".
 */
export default function LifecycleStepper({ stage }: { stage: RentalStage }) {
  const closed = stage === 'closed';
  const currentIdx = closed ? -1 : STAGE_STEPS.findIndex((s) => s.key === stage);

  return (
    <div>
      <ol className="flex items-center gap-1">
        {STAGE_STEPS.map((s, i) => {
          const done = !closed && i < currentIdx;
          const current = !closed && i === currentIdx;
          const dot = done
            ? 'bg-brand-600 text-white'
            : current
              ? 'bg-white text-brand-700 ring-2 ring-brand-500'
              : 'bg-surface-alt text-ink-mute';
          const line = !closed && i < currentIdx ? 'bg-brand-500' : 'bg-line';
          return (
            <React.Fragment key={s.key}>
              {i > 0 && <span className={`h-px flex-1 ${line}`} aria-hidden />}
              <div className="flex items-center gap-2">
                <span
                  className={`h-6 w-6 shrink-0 grid place-items-center rounded-full text-[11px] font-semibold ${dot}`}
                >
                  {done ? '✓' : i + 1}
                </span>
                <span
                  className={`text-xs font-medium whitespace-nowrap ${
                    current ? 'text-ink-deep' : done ? 'text-ink-soft' : 'text-ink-mute'
                  }`}
                >
                  {s.label}
                </span>
              </div>
            </React.Fragment>
          );
        })}
      </ol>
      {closed && (
        <p className="mt-2 text-[11px] font-medium text-status-error-text">
          This lease was closed (cancelled or rejected).
        </p>
      )}
    </div>
  );
}

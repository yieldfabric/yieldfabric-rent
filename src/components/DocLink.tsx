import React from 'react';

/** Small external documentation link — the tutorial affordance used
 *  throughout the app. Keeps target/rel hygiene in one place. */
export default function DocLink({
  href,
  children,
  className,
  title,
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={title}
      className={
        className ??
        'text-brand-600 hover:text-brand-700 underline decoration-brand-200 underline-offset-2'
      }
    >
      {children}
      <span aria-hidden className="ml-0.5 text-[0.85em]">↗</span>
    </a>
  );
}

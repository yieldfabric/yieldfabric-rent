/** @type {import('tailwindcss').Config} */

/**
 * The wallet-SDK's UI (login form, provider chips, signature drawer,
 * incoming-payments inbox, onboarding) renders against a documented set
 * of SEMANTIC token names — `bg-surface`, `text-text-primary`,
 * `bg-chip`, `bg-cta`, … — that the HOST app's Tailwind config must
 * define. Mapping them here is the entire theming contract: change
 * these values and every SDK surface re-skins to your brand.
 *
 * This example ships an EMERALD "property / lease" accent to show the
 * theming knob in action — it is the only thing that differs from the
 * canonical light theme used by the sibling examples. Swap the `brand`
 * scale (and the `primary` / `cta` / `accent` semantic tokens that
 * point at it) for your own and both the app's pages and the SDK chrome
 * re-skin together. The terminal package is also included in `content`
 * so its utility classes are generated.
 */
module.exports = {
  content: [
    './src/**/*.{js,jsx,ts,tsx}',
    // Scan wherever the SDK classes live. Globs that match nothing are
    // no-ops, so listing both lets the same config serve either mode:
    //   - local source (monorepo dev): the sibling src trees
    '../../yieldfabric-wallet-sdk/src/**/*.{js,jsx,ts,tsx}',
    '../../yieldfabric-terminal/src/**/*.{js,jsx,ts,tsx}',
    //   - published packages (standalone): the compiled dist (className
    //     strings intact — tsup does not minify)
    './node_modules/@yieldfabric/wallet/dist/**/*.{js,cjs}',
    './node_modules/@yieldfabric/terminal/dist/**/*.{js,cjs}',
  ],
  theme: {
    extend: {
      colors: {
        // Brand palette — emerald. Swap for your own.
        brand: {
          50: '#ecfdf5',
          100: '#d1fae5',
          200: '#a7f3d0',
          300: '#6ee7b7',
          400: '#34d399',
          500: '#10b981',
          600: '#059669', // primary
          700: '#047857',
          800: '#065f46',
          900: '#064e3b',
        },
        ink: {
          DEFAULT: '#32373c',
          deep: '#0e1726',
          soft: '#5f6b7a',
          mute: '#8a93a3',
        },
        line: {
          DEFAULT: '#e3e8f0',
          soft: '#eef1f6',
          strong: '#c7d0dc',
        },

        // ── Semantic tokens consumed by the wallet-SDK ────────────
        // Surfaces
        page: '#ffffff',
        surface: '#ffffff',
        'surface-alt': '#f6f9f7',
        raised: '#ffffff',
        'raised-hover': '#f6f9f7',
        overlay: 'rgba(255,255,255,0.92)',
        background: '#ffffff',

        // Borders
        'border-default': '#e3e8f0',
        'border-light': '#eef1f6',
        'border-strong': '#c7d0dc',

        // Text
        'text-primary': '#0e1726',
        'text-secondary': '#32373c',
        'text-muted': '#5f6b7a',
        'text-inverse': '#ffffff',

        // Brand primary (accent / glow / border)
        primary: '#059669',
        'primary-muted': 'rgba(5,150,105,0.10)',
        'primary-soft': 'rgba(5,150,105,0.08)',
        accent: '#10b981',

        // CTA — the high-emphasis button fill.
        cta: '#059669',
        'cta-hover': '#047857',
        'on-cta': '#ffffff',

        // Chip — small elevated surfaces (sign-in chips, pills).
        chip: '#f6f9f7',
        'chip-hover': '#e9f6ef',
        'chip-active': '#d1fae5',

        // Input
        'input-bg': '#ffffff',

        // Status — signature drawer / toasts / rent-roll badges.
        'status-success-bg': '#dcf0e6',
        'status-success-text': '#1a6b42',
        'status-warning-bg': '#fbf3d4',
        'status-warning-text': '#7a6518',
        'status-error-bg': '#fde2e7',
        'status-error-text': '#9b2c3c',
        'status-info-bg': '#dceaf8',
        'status-info-text': '#1a5090',

        // Pastels — soft badge fills used by SDK surfaces.
        'pastel-peach': '#fde6d5',
        'pastel-lavender': '#e9e2f5',
        'pastel-mint': '#d4f0e4',
        'pastel-sky': '#dceaf8',
        'pastel-rose': '#fbe2e6',
        'pastel-lemon': '#fbf3d4',
        'pastel-lilac': '#ecdef6',
        'pastel-coral': '#fde4dd',

        // Legacy aliases still referenced by some SDK code.
        textDarkMain: '#0e1726',
        textDarkSecondary: '#5f6b7a',
        borderDark: '#e3e8f0',
      },
      fontFamily: {
        sans: ['system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        display: ['system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      boxShadow: {
        card: '0 1px 2px rgba(14,23,38,0.04), 0 4px 12px rgba(14,23,38,0.04)',
        focus: '0 0 0 3px rgba(5,150,105,0.18)',
      },
    },
  },
  plugins: [],
};

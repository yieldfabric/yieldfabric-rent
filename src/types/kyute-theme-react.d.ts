/**
 * Type shim for `@avatune/kyute-theme/react`.
 *
 * The package resolves its `/react` subpath types through package.json
 * `exports`, which TypeScript 4.9's `node` moduleResolution can't see
 * (the runtime import bundles fine — webpack honours `exports`). The
 * wallet-SDK imports it in one place (`SkeletonAvatar.tsx`) as an
 * opaque theme object passed straight to `<Avatar theme={…}>`, so an
 * `any` default export keeps `npm run typecheck` green without
 * masking anything meaningful.
 *
 * Remove this (and the tsconfig `paths` entry) if the example moves to
 * `moduleResolution: "bundler"` on TypeScript ≥ 5.
 */
declare module '@avatune/kyute-theme/react' {
  const theme: any;
  export default theme;
}

const path = require('path');
const fs = require('fs');

/**
 * Webpack overrides — local SDK source when present, else published packages.
 *
 * Resolution is automatic:
 *   - In the monorepo (the sibling repos exist at ../../yieldfabric-*), the
 *     SDKs are built FROM SOURCE — edit `@yieldfabric/wallet` or
 *     `@yieldfabric/terminal` and the change shows up here with no rebuild,
 *     exactly like `yieldfabric-app`.
 *   - In a standalone checkout (no siblings), the SDKs come from the
 *     published packages installed under node_modules/@yieldfabric/* (see
 *     `.npmrc` → GitHub Packages).
 *
 * Force the published path from inside the monorepo with
 * `YF_FORCE_REGISTRY=1 npm run build` (handy for testing the deployed shape).
 */
const WALLET_SRC = path.resolve(__dirname, '../../yieldfabric-wallet-sdk/src');
const TERMINAL_SRC = path.resolve(__dirname, '../../yieldfabric-terminal/src');
const USE_LOCAL =
  !process.env.YF_FORCE_REGISTRY &&
  fs.existsSync(WALLET_SRC) &&
  fs.existsSync(TERMINAL_SRC);

module.exports = {
  webpack: {
    configure: (webpackConfig) => {
      // Drop CRA's ModuleScopePlugin so we can alias to files outside src/
      // (the dedupe aliases below, and the SDK src trees in local mode).
      webpackConfig.resolve.plugins = (webpackConfig.resolve.plugins || []).filter(
        (p) => p.constructor && p.constructor.name !== 'ModuleScopePlugin'
      );

      if (USE_LOCAL) {
        // ── Local source mode ──────────────────────────────────────────
        // Transpile the SDK .tsx alongside the app's, point the package
        // specifiers at the sibling src, and let imports issued from inside
        // the SDK source resolve their own deps from the SDK's node_modules.
        const oneOf = (webpackConfig.module.rules.find((r) => r.oneOf) || {}).oneOf;
        const tsxRule =
          oneOf &&
          oneOf.find(
            (r) => r.test && (r.test.toString().includes('tsx') || r.test.toString().includes('jsx'))
          );
        if (tsxRule) {
          tsxRule.include = [tsxRule.include, TERMINAL_SRC, WALLET_SRC];
        }
        webpackConfig.resolve.modules = [
          ...(webpackConfig.resolve.modules || ['node_modules']),
          path.resolve(__dirname, 'node_modules'),
          path.resolve(__dirname, '../../yieldfabric-terminal/node_modules'),
          path.resolve(__dirname, '../../yieldfabric-wallet-sdk/node_modules'),
        ];
        webpackConfig.resolve.alias = {
          ...webpackConfig.resolve.alias,
          '@yieldfabric/terminal': TERMINAL_SRC,
          '@yieldfabric/wallet': WALLET_SRC,
        };
      } else {
        // ── Published package mode ─────────────────────────────────────
        // SDKs resolve from node_modules/@yieldfabric/* via their exports
        // map. Silence the bundles' source-map warnings (their .ts sources
        // aren't shipped — harmless noise).
        webpackConfig.ignoreWarnings = [
          ...(webpackConfig.ignoreWarnings || []),
          /Failed to parse source map/,
        ];
      }

      // One physical copy of every dep shared across the app↔SDK boundary —
      // avoids the duplicate-React "invalid hook call" crash. Valid in both
      // modes (all are direct deps of this app).
      webpackConfig.resolve.alias = {
        ...webpackConfig.resolve.alias,
        react: path.resolve(__dirname, 'node_modules/react'),
        'react-dom': path.resolve(__dirname, 'node_modules/react-dom'),
        'framer-motion': path.resolve(__dirname, 'node_modules/framer-motion'),
        'lucide-react': path.resolve(__dirname, 'node_modules/lucide-react'),
        'react-markdown': path.resolve(__dirname, 'node_modules/react-markdown'),
        zod: path.resolve(__dirname, 'node_modules/zod'),
        'js-sha3': path.resolve(__dirname, 'node_modules/js-sha3'),
        '@heroicons/react': path.resolve(__dirname, 'node_modules/@heroicons/react'),
      };

      // Type checking is the dedicated `npm run typecheck` step, not the build.
      webpackConfig.plugins = webpackConfig.plugins.filter(
        (p) => p.constructor && p.constructor.name !== 'ForkTsCheckerWebpackPlugin'
      );

      return webpackConfig;
    },
  },
};

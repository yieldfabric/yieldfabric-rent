#!/usr/bin/env node
/**
 * postinstall: prepare the YieldFabric SDKs for whichever mode applies.
 *
 *  - Monorepo (sibling repos exist at ../../yieldfabric-*): install each
 *    sibling's own dependencies so that webpack/tsc can resolve the SDK
 *    source's transitive deps (@dicebear, @xyflow, @avatune, …) from the
 *    sibling's node_modules. craco/tailwind/tsconfig then build from that
 *    live source (see craco.config.js).
 *  - Standalone checkout (no siblings): nothing to do — the SDKs come from
 *    the published @yieldfabric/* packages installed under node_modules
 *    (declared in optionalDependencies, resolved via .npmrc → GitHub
 *    Packages).
 *
 * Best-effort: a failure here never fails the host install — it just falls
 * back to whatever is in node_modules.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SIBLINGS = ['yieldfabric-wallet-sdk', 'yieldfabric-terminal'];
const repoRoot = path.resolve(__dirname, '..', '..', '..');

let linkedAny = false;
for (const repo of SIBLINGS) {
  const dir = path.join(repoRoot, repo);
  if (!fs.existsSync(path.join(dir, 'src'))) continue; // not a local checkout
  linkedAny = true;
  try {
    console.log(`[setup-sdks] local ${repo} found → installing its deps for source build`);
    execSync('npm install --no-audit --no-fund --ignore-scripts', {
      cwd: dir,
      stdio: 'inherit',
    });
  } catch (err) {
    console.warn(
      `[setup-sdks] warning: could not install deps for ${repo} (${err.message}). ` +
        `Run "npm install" inside ${dir} manually if the build can't resolve its deps.`
    );
  }
}

if (!linkedAny) {
  console.log(
    '[setup-sdks] no local SDK checkouts — using the published @yieldfabric/* packages from the registry'
  );
}

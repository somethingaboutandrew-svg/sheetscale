// Signed Mac App Store build. The provisioning profile is never committed: pass its path in
// SHEETSCALE_MAS_PROFILE, or put it at desktop/build/embedded.provisionprofile (gitignored).
// Extra arguments go to electron-builder, e.g. -c.buildVersion=2 for a re-upload. Universal unless --arm64/--x64 is given.
const { existsSync } = require('node:fs');
const { resolve } = require('node:path');
const { execFileSync } = require('node:child_process');
const profile = resolve(process.env.SHEETSCALE_MAS_PROFILE || resolve(__dirname, '..', 'build', 'embedded.provisionprofile'));
if (!existsSync(profile)) {
  console.error(`Provisioning profile not found: ${profile}\nSet SHEETSCALE_MAS_PROFILE or copy it to desktop/build/embedded.provisionprofile.`);
  process.exit(1);
}
const args = process.argv.slice(2);
const arch = args.some((a) => /^--(arm64|x64|universal)$/.test(a)) ? [] : ['--universal'];
const cli = ['electron-builder', '--mac', 'mas', ...arch, ...args, '--publish', 'never', `-c.mas.provisioningProfile=${profile}`];
console.log('Using provisioning profile', profile);
execFileSync('npx', cli, { stdio: 'inherit', cwd: resolve(__dirname, '..') });

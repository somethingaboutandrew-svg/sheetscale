// Signed Mac App Store build. The provisioning profile is never committed: pass its path in
// SHEETSCALE_MAS_PROFILE, or put it at desktop/build/embedded.provisionprofile (gitignored).
// Extra arguments go to electron-builder, e.g. -c.buildVersion=2 for a re-upload. Universal unless --arm64/--x64 is given.
//
// The profile is copied to a temp file with mode 0644 first: electron-builder copies it into the .app
// keeping its mode, and Apple rejects packages with files only root can read (ITMS 90255-style
// "installer package includes files only readable by root"). After the build every file and folder
// in the .app is checked to be world-readable.
const { existsSync, copyFileSync, chmodSync, mkdtempSync, rmSync, readdirSync, lstatSync } = require('node:fs');
const { resolve, join } = require('node:path');
const { tmpdir } = require('node:os');
const { execFileSync } = require('node:child_process');

const src = resolve(process.env.SHEETSCALE_MAS_PROFILE || resolve(__dirname, '..', 'build', 'embedded.provisionprofile'));
if (!existsSync(src)) {
  console.error(`Provisioning profile not found: ${src}\nSet SHEETSCALE_MAS_PROFILE or copy it to desktop/build/embedded.provisionprofile.`);
  process.exit(1);
}
const tmp = mkdtempSync(join(tmpdir(), 'sheetscale-mas-'));
const profile = join(tmp, 'embedded.provisionprofile');
copyFileSync(src, profile);
chmodSync(profile, 0o644);

/** Paths inside `root` that are not world-readable (files: o+r; folders: o+rx). Symlinks are skipped. */
function unreadable(root) {
  const bad = [];
  const walk = (p) => {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) return;
    const need = st.isDirectory() ? 0o005 : 0o004;
    if ((st.mode & need) !== need) bad.push(`${(st.mode & 0o777).toString(8)} ${p}`);
    if (st.isDirectory()) for (const f of readdirSync(p)) walk(join(p, f));
  };
  walk(root);
  return bad;
}

const args = process.argv.slice(2);
const arch = args.some((a) => /^--(arm64|x64|universal)$/.test(a)) ? [] : ['--universal'];
const cli = ['electron-builder', '--mac', 'mas', ...arch, ...args, '--publish', 'never', `-c.mas.provisioningProfile=${profile}`];
console.log('Using provisioning profile', src, '(copied as 0644)');
const startedAt = Date.now();
try {
  execFileSync('npx', cli, { stdio: 'inherit', cwd: resolve(__dirname, '..') });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const release = resolve(__dirname, '..', 'release');
const apps = (existsSync(release) ? readdirSync(release) : [])
  .filter((d) => /^mas(-|$)/.test(d) && !/-dev$/.test(d))
  .map((d) => join(release, d, 'SheetScale.app'))
  .filter((p) => existsSync(p) && lstatSync(p).mtimeMs >= startedAt - 1000);
if (!apps.length) { console.error('Post-build check: no freshly built SheetScale.app found under release/mas*'); process.exit(1); }
let failed = false;
for (const app of apps) {
  const bad = unreadable(app);
  if (bad.length) {
    failed = true;
    console.error(`Post-build check FAILED: ${bad.length} item(s) in ${app} are not world-readable (Apple rejects these):\n  ${bad.slice(0, 50).join('\n  ')}`);
  } else console.log(`Post-build check OK: every file in ${app} is world-readable.`);
}
if (failed) process.exit(1);

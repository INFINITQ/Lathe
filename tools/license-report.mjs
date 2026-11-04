// Lists the licenses of everything Lathe ships: the npm packages its UI installs for production
// (from pnpm) and the Rust crates compiled into lathe.exe (from cargo; normal dependencies only,
// not build tools). Works offline. Writes docs/licenses.md, and fails when a package states no
// license.
//
// Usage: node tools/license-report.mjs   (or: pnpm licenses:report)
import { execFileSync, execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const APP = '@lathe/app';
const BIG = { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 };
/** Licenses that ask something of whoever shares the app (fine for personal use). */
const COPYLEFT = /\b(A?GPL|LGPL|MPL|EPL|CDDL|EUPL|OSL|CC-BY-SA)\b/i;

// npm: the packages the app installs for production.
const npm = new Map();
const listed = JSON.parse(execSync(`pnpm --filter ${APP} licenses list --prod --json`, BIG));
for (const [license, packages] of Object.entries(listed)) {
  for (const pkg of packages) {
    if (pkg.name.startsWith('@lathe/')) continue;
    for (const version of pkg.versions) {
      npm.set(`${pkg.name}@${version}`, { name: pkg.name, version, license });
    }
  }
}

// Rust: crates reachable from the workspace through normal (shipped) dependencies, on Windows.
const metadata = JSON.parse(
  execFileSync(
    'cargo',
    [
      'metadata',
      '--format-version',
      '1',
      '--offline',
      '--filter-platform',
      'x86_64-pc-windows-msvc',
    ],
    BIG,
  ),
);
const packages = new Map(metadata.packages.map((p) => [p.id, p]));
const nodes = new Map(metadata.resolve.nodes.map((n) => [n.id, n]));
const members = new Set(metadata.workspace_members);
// The app and the core it's built on; the test kit (fake servers) isn't shipped.
const roots = [...members].filter((id) => ['lathe', 'lathe-core'].includes(packages.get(id)?.name));
const shipped = new Set();
const queue = [...roots];
while (queue.length) {
  const node = nodes.get(queue.pop());
  for (const dep of node?.deps ?? []) {
    if (!dep.dep_kinds.some((kind) => kind.kind === null) || shipped.has(dep.pkg)) continue;
    shipped.add(dep.pkg);
    queue.push(dep.pkg);
  }
}
const rust = [...shipped]
  .filter((id) => !members.has(id))
  .map((id) => packages.get(id))
  .map((p) => ({
    name: p.name,
    version: p.version,
    license: p.license ?? (p.license_file ? 'see its license file' : ''),
  }))
  .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

const npmList = [...npm.values()].sort(
  (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
);
const unlicensed = [...npmList, ...rust].filter(
  (p) => !p.license || /^(unknown|unlicensed)$/i.test(p.license),
);
const copyleft = [...npmList, ...rust].filter((p) => COPYLEFT.test(p.license));

const counts = new Map();
for (const p of npmList) {
  const c = counts.get(p.license) ?? { npm: 0, rust: 0 };
  counts.set(p.license, { ...c, npm: c.npm + 1 });
}
for (const p of rust) {
  const c = counts.get(p.license) ?? { npm: 0, rust: 0 };
  counts.set(p.license, { ...c, rust: c.rust + 1 });
}
const cell = (text) => String(text).replace(/\|/g, '\\|');

const lines = [
  '# Third-party licenses',
  '',
  `Made by \`node tools/license-report.mjs\` on ${new Date().toISOString().slice(0, 10)}. It lists what Lathe ships:`,
  `${npmList.length} npm packages its UI installs for production (most are bundled into the UI, some only in part) and`,
  `${rust.length} Rust crates compiled into lathe.exe. Build tools and test-only packages are left out.`,
  '',
  'Language servers, debug adapters and Jupyter kernels are not shipped. Lathe downloads the ones you',
  'ask for (each pinned to a version and checked against a SHA-256) into its own folder, or uses the',
  'ones you have installed; each comes with its own license. Plugins you install are likewise their',
  "authors' own.",
  '',
  '## Summary',
  '',
  '| License | npm | Rust |',
  '| --- | ---: | ---: |',
  ...[...counts.entries()]
    .sort((a, b) => b[1].npm + b[1].rust - (a[1].npm + a[1].rust))
    .map(([license, n]) => `| ${cell(license || '(none)')} | ${n.npm} | ${n.rust} |`),
  '',
  '## Copyleft',
  '',
  copyleft.length
    ? 'These ask that changes to them be shared when the app is given to others (personal use is unaffected):'
    : 'None.',
  ...(copyleft.length
    ? ['', ...copyleft.map((p) => `- ${p.name} ${p.version}: ${p.license}`)]
    : []),
  '',
  '## npm packages',
  '',
  '| Package | Version | License |',
  '| --- | --- | --- |',
  ...npmList.map((p) => `| ${cell(p.name)} | ${p.version} | ${cell(p.license)} |`),
  '',
  '## Rust crates',
  '',
  '| Crate | Version | License |',
  '| --- | --- | --- |',
  ...rust.map((p) => `| ${cell(p.name)} | ${p.version} | ${cell(p.license)} |`),
  '',
];
writeFileSync(new URL('../docs/licenses.md', import.meta.url), lines.join('\n'));
console.log(
  `docs/licenses.md: ${npmList.length} npm packages, ${rust.length} Rust crates, ${copyleft.length} copyleft.`,
);
if (unlicensed.length) {
  console.error(`No license stated: ${unlicensed.map((p) => `${p.name} ${p.version}`).join(', ')}`);
  process.exit(1);
}

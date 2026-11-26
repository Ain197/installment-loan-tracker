// Builds one Lambda zip per service: infra/.build/<service>.zip
// Each zip holds: node_modules (production libraries only), shared/ and the service folder.
// The Lambda handler is therefore "<service>/lambda.handler", e.g. plans/lambda.handler.
// .env files are never included. Usage: node infra/build-zips.js [service ...]
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const servicesDir = path.join(root, 'services');
const buildDir = path.join(__dirname, '.build');
const depsDir = path.join(buildDir, 'deps');
const AdmZip = require(path.join(servicesDir, 'node_modules', 'adm-zip'));

const ALL = ['auth', 'plans', 'payments', 'reminders'];
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : ALL;

function installProductionDeps() {
  fs.mkdirSync(depsDir, { recursive: true });
  const lock = path.join(servicesDir, 'package-lock.json');
  const stamp = path.join(depsDir, '.lock-copy');
  const current = fs.readFileSync(lock, 'utf8');
  if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === current && fs.existsSync(path.join(depsDir, 'node_modules'))) {
    console.log('production libraries are up to date');
    return;
  }
  fs.copyFileSync(path.join(servicesDir, 'package.json'), path.join(depsDir, 'package.json'));
  fs.copyFileSync(lock, path.join(depsDir, 'package-lock.json'));
  console.log('installing production libraries (npm ci --omit=dev) ...');
  execSync('npm ci --omit=dev --no-audit --no-fund', { cwd: depsDir, stdio: 'inherit', shell: true });
  fs.writeFileSync(stamp, current);
}

function addFolder(zip, dir, zipPath) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.env' || entry.name.startsWith('.env.')) continue;
    const full = path.join(dir, entry.name);
    const inZip = `${zipPath}/${entry.name}`;
    if (entry.isDirectory()) addFolder(zip, full, inZip);
    else zip.addFile(inZip, fs.readFileSync(full));
  }
}

installProductionDeps();
for (const service of wanted) {
  if (!ALL.includes(service)) throw new Error(`Unknown service "${service}". Use one of: ${ALL.join(', ')}`);
  const zip = new AdmZip();
  addFolder(zip, path.join(depsDir, 'node_modules'), 'node_modules');
  addFolder(zip, path.join(servicesDir, 'shared'), 'shared');
  addFolder(zip, path.join(servicesDir, service), service);
  const out = path.join(buildDir, `${service}.zip`);
  zip.writeZip(out);
  console.log(`built ${path.relative(root, out)} (${(fs.statSync(out).size / 1048576).toFixed(1)} MB)`);
}

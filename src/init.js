import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const xtaticPkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
const xtaticVersion = JSON.parse(
  fs.readFileSync(xtaticPkgPath, 'utf8'),
).version;

function sortByKey(obj) {
  return Object.fromEntries(
    Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

export function runInit({ topDir, log = (m) => console.log(m) }) {
  const pkgPath = path.join(topDir, 'package.json');
  let pkg;
  let created = false;
  if (fs.existsSync(pkgPath)) {
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    } catch (e) {
      throw new Error(`Failed to parse ${pkgPath}: ${e.message}`);
    }
    if (pkg === null || typeof pkg !== 'object' || Array.isArray(pkg)) {
      throw new Error(`${pkgPath} must contain a JSON object.`);
    }
  } else {
    fs.mkdirSync(topDir, { recursive: true });
    pkg = {
      name: path.basename(path.resolve(topDir)),
      version: '0.0.0',
      private: true,
    };
    created = true;
  }

  const inDeps =
    pkg.dependencies != null && pkg.dependencies.xtatic !== undefined;
  const inDevDeps =
    pkg.devDependencies != null && pkg.devDependencies.xtatic !== undefined;
  let addedDep = false;
  if (!inDeps && !inDevDeps) {
    if (pkg.devDependencies == null) {
      pkg.devDependencies = {};
    } else if (
      typeof pkg.devDependencies !== 'object' ||
      Array.isArray(pkg.devDependencies)
    ) {
      throw new Error(`${pkgPath}: devDependencies must be an object.`);
    }
    pkg.devDependencies.xtatic = `^${xtaticVersion}`;
    pkg.devDependencies = sortByKey(pkg.devDependencies);
    addedDep = true;
  }

  if (pkg.xtatic == null) {
    pkg.xtatic = {};
  } else if (typeof pkg.xtatic !== 'object' || Array.isArray(pkg.xtatic)) {
    throw new Error(`${pkgPath}: xtatic must be an object.`);
  }
  const enabledAutoInstall = pkg.xtatic.autoInstall !== true;
  pkg.xtatic.autoInstall = true;

  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

  const actions = [];
  if (created) actions.push(`created ${pkgPath}`);
  if (addedDep) actions.push(`added devDependencies.xtatic = "^${xtaticVersion}"`);
  if (enabledAutoInstall) actions.push(`enabled xtatic.autoInstall`);
  if (actions.length === 0) {
    log(`[xtatic] init: nothing to do (already configured).`);
  } else {
    for (const action of actions) log(`[xtatic] init: ${action}`);
    if (created || addedDep) {
      log(`[xtatic] run \`npm install\`, then \`xtatic build\` to build your site.`);
    }
  }

  return { created, addedDep, enabledAutoInstall };
}

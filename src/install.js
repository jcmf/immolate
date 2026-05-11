import { spawn } from 'node:child_process';

export function defaultInstallPackage({ pkg, topDir }) {
  return new Promise((resolve, reject) => {
    const proc = spawn('npm', ['install', '--save-dev', pkg], {
      cwd: topDir,
      stdio: 'inherit',
    });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(`npm install ${pkg} (in ${topDir}) exited with code ${code}.`),
        );
    });
  });
}

// Try `importer()`; on failure, if `autoInstall` is set and we have a `topDir`,
// run `install({pkg, topDir})` and retry the import once. If still failing —
// or autoInstall is off — throw `missingMessage`.
export async function loadOptionalDep({
  pkg,
  importer,
  autoInstall,
  topDir,
  install = defaultInstallPackage,
  missingMessage,
  log = (msg) => console.error(msg),
}) {
  try {
    return await importer();
  } catch {
    if (!autoInstall || !topDir) {
      throw new Error(missingMessage);
    }
    log(`[xtatic] auto-installing ${pkg} into ${topDir}…`);
    await install({ pkg, topDir });
    try {
      return await importer();
    } catch {
      throw new Error(missingMessage);
    }
  }
}

import { cp, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';
import { rcedit } from 'rcedit';

const desktopRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(process.argv[5] || resolve(desktopRoot, '..'));
const destination = resolve(process.argv[2] || '');
const brandRoot = resolve(process.argv[3] || '');
const version = String(process.argv[4] || '0.3.12.0');
if (destination === desktopRoot || destination === repositoryRoot || brandRoot === desktopRoot || brandRoot === repositoryRoot) {
  throw new Error('Expected separate MSI staging and brand directories.');
}

const distRoot = dirname(electronPath);
await mkdir(destination, { recursive: true });
await cp(distRoot, destination, { recursive: true });
const originalExe = join(destination, 'electron.exe');
const brandedExe = join(destination, 'AgentoC.exe');
await rename(originalExe, brandedExe);

const appRoot = join(destination, 'resources', 'app');
const assetsRoot = join(appRoot, 'assets');
await mkdir(assetsRoot, { recursive: true });
for (const name of ['main.cjs', 'preload.cjs', 'wait.html']) {
  await cp(join(desktopRoot, name), join(appRoot, name));
}
await cp(join(repositoryRoot, 'static', 'desktop', 'agentoc-android-logo.png'), join(assetsRoot, 'agentoc-android-logo.png'));
await writeFile(join(appRoot, 'package.json'), `${JSON.stringify({
  name: 'agentoc-desktop-manager',
  version,
  private: true,
  main: 'main.cjs',
}, null, 2)}\n`, 'utf8');

await rcedit(brandedExe, {
  icon: join(brandRoot, 'agentoc.ico'),
  'requested-execution-level': 'asInvoker',
  'file-version': version,
  'product-version': version,
  'version-string': {
    CompanyName: 'AgentoC',
    FileDescription: 'AgentoC Desktop Manager',
    InternalName: 'AgentoC',
    OriginalFilename: 'AgentoC.exe',
    ProductName: 'AgentoC',
  },
});

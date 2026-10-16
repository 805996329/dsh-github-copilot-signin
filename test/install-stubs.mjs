/**
 * Install the three harness peer stubs the selftest needs, so `node test/selftest.mjs`
 * loads the package's `index.js` unchanged. The real peers are DSH runtime packages
 * that cannot be installed outside a DSH install, so the stubs reproduce only the
 * symbols the plugin imports; every behaviour under test is the plugin's own.
 *
 * The plugin sits at the package root and imports by bare specifier, so Node resolves
 * from there: the stubs go into the root `node_modules`, which must stay gitignored.
 *
 * Run: node test/install-stubs.mjs
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const rootModules = join(here, '..', 'node_modules');
const scopeDir = join(rootModules, '@deepseek-ai');

const stubs = {
  'dsh-tools': {
    description: 'stub of @deepseek-ai/dsh-tools for the selftest',
    body: 'export const defineTool = (options) => options;\n',
  },
  'dsh-authorization': {
    description: 'stub of @deepseek-ai/dsh-authorization for the selftest',
    body: [
      'export class AuthorizationDeclinedError extends Error {',
      '  constructor(message = "the authorization prompt was declined") {',
      '    super(message);',
      '    this.code = "DECLINED";',
      '    this.name = "AuthorizationDeclinedError";',
      '  }',
      '}',
      '',
    ].join('\n'),
  },
  'dsh-credentials': {
    description: 'stub of @deepseek-ai/dsh-credentials for the selftest',
    body: 'export const credentialKey = (scope, id) => `${scope}/${id}`;\n',
  },
};

rmSync(rootModules, { recursive: true, force: true });
for (const [name, stub] of Object.entries(stubs)) {
  const dir = join(scopeDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify({ name: `@deepseek-ai/${name}`, version: '0.0.0-stub', private: true, type: 'module', main: 'index.js', description: stub.description }, null, 2)}\n`,
  );
  writeFileSync(join(dir, 'index.js'), stub.body);
}
console.log(`installed ${Object.keys(stubs).length} stubs under <package>/node_modules (gitignored)`);

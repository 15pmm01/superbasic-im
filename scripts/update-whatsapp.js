'use strict';

const {spawnSync} = require('child_process');
const fs = require('fs');
const path = require('path');

const projectDir = path.resolve(__dirname, '..');
const packagePath = path.join(projectDir, 'package.json');
const lockPath = path.join(projectDir, 'package-lock.json');
const repository = 'github.com/pedroslopez/whatsapp-web.js.git';
const dependencySpec = `git+https://${repository}#main`;

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const install = spawnSync(
  npmCommand,
  ['install', `whatsapp-web.js@${dependencySpec}`],
  {
    cwd: projectDir,
    stdio: 'inherit',
  }
);

if (install.error) throw install.error;
if (install.status !== 0) {
  throw new Error(`npm install failed with exit code ${install.status}`);
}

const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
const packageLock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
const lockRoot = packageLock.packages && packageLock.packages[''];
const lockDependencies = lockRoot && lockRoot.dependencies;
const installed =
  packageLock.packages && packageLock.packages['node_modules/whatsapp-web.js'];

if (!packageJson.dependencies || !lockDependencies || !installed) {
  throw new Error('npm did not create the expected whatsapp-web.js lock entry');
}

const commitMatch = String(installed.resolved || '').match(/#([0-9a-f]{40})$/i);
if (!commitMatch) {
  throw new Error(
    `Could not determine the installed whatsapp-web.js commit from ${installed.resolved}`
  );
}

packageJson.dependencies['whatsapp-web.js'] = dependencySpec;
lockDependencies['whatsapp-web.js'] = dependencySpec;
installed.resolved = `git+https://${repository}#${commitMatch[1]}`;

fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
fs.writeFileSync(lockPath, `${JSON.stringify(packageLock, null, 2)}\n`);

console.log(`whatsapp-web.js is now locked to commit ${commitMatch[1]}`);
console.log('Run npm test and npm run build before restarting the service.');

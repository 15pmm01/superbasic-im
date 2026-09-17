'use strict';

const assert = require('assert/strict');
const {spawnSync} = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectDir = path.resolve(__dirname, '..');
const runtimeDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'superbasic-im-startup-failure-')
);
const childScript = `
  const fs = require('fs');
  const path = require('path');
  const dataDir = process.env.SUPERBASIC_DATA_DIR;
  fs.mkdirSync(dataDir, {recursive: true});
  fs.writeFileSync(path.join(dataDir, 'user.json'), JSON.stringify({
    cookieKey: 'x'.repeat(64),
    hash: 'unused',
    phoneNumber: 'test'
  }));
  const wa = require('./dist/client.js');
  wa.client.initialize = () => Promise.reject(
    new Error('intentional browser startup failure')
  );
  require('./dist/index.js').runApplication();
`;

try {
  const result = spawnSync(process.execPath, ['-e', childScript], {
    cwd: projectDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: '0',
      SUPERBASIC_DATA_DIR: runtimeDir,
    },
    timeout: 10000,
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /\[WA\] FATAL: application startup failed/);
  assert.match(result.stderr, /intentional browser startup failure/);
  assert.match(result.stdout, /Listening on/);
  console.log('fatal-startup-smoke-test=PASS');
} finally {
  fs.rmSync(runtimeDir, {force: true, recursive: true});
}

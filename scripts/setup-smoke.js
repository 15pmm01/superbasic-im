'use strict';

const assert = require('assert/strict');
const {spawn} = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const argon2 = require('argon2');

const projectDir = path.resolve(__dirname, '..');
const entrypoint = path.join(projectDir, 'dist', 'index.js');
const testRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'superbasic-im-setup-smoke-')
);

function permissions(file) {
  return fs.statSync(file).mode & 0o777;
}

function runSetup(dataDir, answers) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entrypoint, 'init'], {
      cwd: projectDir,
      env: {...process.env, SUPERBASIC_DATA_DIR: dataDir},
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const prompts = ['Enter the phone number: ', 'Enter the password: '];
    let answerIndex = 0;
    let stderr = '';
    let stdout = '';

    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`setup timed out; stdout=${stdout}; stderr=${stderr}`));
    }, 30000);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;

      if (
        answerIndex < answers.length &&
        stdout.includes(prompts[answerIndex])
      ) {
        const answer = `${answers[answerIndex]}\n`;
        answerIndex += 1;

        if (answerIndex === answers.length) child.stdin.end(answer);
        else child.stdin.write(answer);
      }
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.on('error', err => {
      clearTimeout(timeout);
      reject(err);
    });
    child.on('close', code => {
      clearTimeout(timeout);
      resolve({code, stderr, stdout});
    });
  });
}

async function main() {
  const validDir = path.join(testRoot, 'valid');
  const valid = await runSetup(validDir, [' test-user ', ' test-password ']);

  assert.equal(valid.code, 0, valid.stderr);
  assert.match(valid.stdout, /User created/);

  const configPath = path.join(validDir, 'user.json');
  const mediaDir = path.join(validDir, 'media');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(config.phoneNumber, 'test-user');
  assert.equal(await argon2.verify(config.hash, 'test-password'), true);
  assert.equal(permissions(validDir), 0o700);
  assert.equal(permissions(mediaDir), 0o700);
  assert.equal(permissions(configPath), 0o600);

  const originalConfig = fs.readFileSync(configPath, 'utf8');
  fs.chmodSync(validDir, 0o755);
  fs.chmodSync(mediaDir, 0o755);
  fs.chmodSync(configPath, 0o644);

  const overwrite = await runSetup(validDir, []);
  assert.equal(overwrite.code, 1);
  assert.match(overwrite.stderr, /Refusing to overwrite existing login/);
  assert.equal(fs.readFileSync(configPath, 'utf8'), originalConfig);
  assert.equal(permissions(validDir), 0o700);
  assert.equal(permissions(mediaDir), 0o700);
  assert.equal(permissions(configPath), 0o600);

  const emptyUserDir = path.join(testRoot, 'empty-user');
  const emptyUser = await runSetup(emptyUserDir, ['   ']);
  assert.equal(emptyUser.code, 1);
  assert.match(emptyUser.stderr, /phone number cannot be empty/i);
  assert.equal(fs.existsSync(path.join(emptyUserDir, 'user.json')), false);

  const emptyPasswordDir = path.join(testRoot, 'empty-password');
  const emptyPassword = await runSetup(emptyPasswordDir, ['test-user', '   ']);
  assert.equal(emptyPassword.code, 1);
  assert.match(emptyPassword.stderr, /password cannot be empty/i);
  assert.equal(fs.existsSync(path.join(emptyPasswordDir, 'user.json')), false);

  console.log('secure-first-run-setup-smoke-test=PASS');
}

main()
  .catch(err => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(testRoot, {force: true, recursive: true});
  });

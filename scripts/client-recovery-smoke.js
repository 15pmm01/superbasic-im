'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const runtimeDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'superbasic-im-client-recovery-')
);

process.env.SUPERBASIC_DATA_DIR = runtimeDir;

// These smoke tests intentionally exercise freshly compiled, ignored output.
// eslint-disable-next-line n/no-unpublished-require
const wa = require('../dist/client.js');
// eslint-disable-next-line n/no-unpublished-require
const routes = require('../dist/routes.js');

function toolkit() {
  return {
    response(payload) {
      return {
        headers: {},
        payload,
        statusCode: 200,
        code(statusCode) {
          this.statusCode = statusCode;
          return this;
        },
        type(contentType) {
          this.headers['content-type'] = contentType;
          return this;
        },
        header(name, value) {
          this.headers[name.toLowerCase()] = value;
          return this;
        },
      };
    },
  };
}

async function expectGetChatsFailure(context) {
  await assert.rejects(wa.getChatsWithRecovery(context), /opaque failure/);
}

async function main() {
  let getStateCalls = 0;
  wa.client.getState = async () => {
    getStateCalls += 1;
    throw new Error('getState must not run before the ready event');
  };

  const startingResponse = await routes.new_chat_or_pair_handler(
    {headers: {}},
    toolkit()
  );

  assert.equal(getStateCalls, 0);
  assert.equal(startingResponse.statusCode, 503);
  assert.match(startingResponse.payload, /connection is restarting/i);

  const exitCodes = [];
  const originalExit = process.exit;
  // eslint-disable-next-line n/no-process-exit
  process.exit = code => {
    exitCodes.push(code);
  };

  try {
    wa.client.getChats = async () => {
      throw new Error('opaque failure');
    };

    await expectGetChatsFailure('before-reset-1');
    await expectGetChatsFailure('before-reset-2');

    wa.client.getChats = async () => [];
    assert.deepEqual(await wa.getChatsWithRecovery('successful-reset'), []);

    wa.client.getChats = async () => {
      throw new Error('opaque failure');
    };

    await expectGetChatsFailure('after-reset-1');
    await expectGetChatsFailure('after-reset-2');
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.deepEqual(exitCodes, []);

    await expectGetChatsFailure('after-reset-3');
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.deepEqual(exitCodes, [1]);
  } finally {
    process.exit = originalExit;
  }

  console.log('whatsapp-client-recovery-smoke-test=PASS');
}

main()
  .catch(err => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(runtimeDir, {force: true, recursive: true});
  });

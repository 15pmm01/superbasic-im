'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const runtimeDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'superbasic-im-smoke-')
);

process.env.HOST = '127.0.0.1';
process.env.PORT = '0';
process.env.SUPERBASIC_DATA_DIR = runtimeDir;
delete process.env.SUPERBASIC_LANGUAGE;

// The smoke test intentionally exercises freshly compiled, ignored output.
// eslint-disable-next-line n/no-unpublished-require
const paths = require('../dist/paths.js');
paths.ensureRuntimeDirectories();
fs.writeFileSync(
  paths.USER_CONFIG_PATH,
  JSON.stringify({
    cookieKey: 'x'.repeat(64),
    hash: 'unused',
    phoneNumber: 'test',
  })
);

// eslint-disable-next-line n/no-unpublished-require
const app = require('../dist/index.js');

async function expectLogin(
  server,
  format,
  acceptLanguage,
  responseLanguage,
  expected
) {
  const headers = {'accept-language': acceptLanguage};
  if (format === 'wml') headers['x-superbasic-format'] = 'wml';

  const response = await server.inject({
    headers,
    method: 'GET',
    url: '/login',
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['content-language'], responseLanguage);
  assert.match(response.headers.vary, /Accept-Language/i);
  assert.match(response.payload, expected);

  const expectedType = format === 'wml' ? 'text/vnd.wap.wml' : 'text/html';
  assert.match(response.headers['content-type'], new RegExp(expectedType));
}

async function main() {
  const server = await app.init();

  try {
    await expectLogin(server, 'html', 'en-US', 'en', /Username/);
    await expectLogin(server, 'html', 'de-DE', 'de', /Benutzername/);
    await expectLogin(server, 'wml', 'en-US', 'en', /Phone number/);
    await expectLogin(server, 'wml', 'de-DE', 'de', /Telefonnummer/);
    await expectLogin(
      server,
      'html',
      'en;q=0.4,de;q=0.9',
      'de',
      /Benutzername/
    );

    process.env.SUPERBASIC_LANGUAGE = 'de';
    await expectLogin(server, 'html', 'en-US', 'de', /Benutzername/);
    delete process.env.SUPERBASIC_LANGUAGE;

    const css = await server.inject({
      method: 'GET',
      url: '/public/css/style.css',
    });
    assert.equal(css.statusCode, 200);
    assert.match(css.headers['content-type'], /^text\/css/);
    assert.ok(css.payload.length > 1000);

    const templateModel = {
      chats: [],
      crumb: 'test',
      htmlHost: 'im.example.com',
      items: [],
      messages: [],
      participants: [],
      users: [],
    };
    const htmlViews = [
      'chatinfo',
      'chats',
      'contacts',
      'index',
      'login',
      'new',
      'pair',
    ];
    const wmlViews = [
      'chatinfo',
      'chats',
      'contacts',
      'index',
      'login',
      'new',
      'pair-required',
    ];

    for (const language of ['de', 'en']) {
      for (const view of htmlViews) {
        await server.render(`${language}/${view}.html`, templateModel);
      }

      for (const view of wmlViews) {
        await server.render(`wml/${language}/${view}.wml`, templateModel);
      }
    }

    const englishPairing = await server.render(
      'wml/en/pair-required.wml',
      templateModel
    );
    assert.match(englishPairing, /im\.example\.com/);

    const englishNew = await server.render('wml/en/new.wml', templateModel);
    assert.match(englishNew, /name="user" value="custom"/);

    console.log('localized-html-wml-smoke-test=PASS');
  } finally {
    await server.stop();
    fs.rmSync(runtimeDir, {force: true, recursive: true});
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});

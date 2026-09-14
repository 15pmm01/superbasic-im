'use strict';

const assert = require('assert/strict');
const {spawnSync} = require('child_process');
const fs = require('fs');
// Puppeteer is the browser dependency pinned by whatsapp-web.js.
// eslint-disable-next-line n/no-extraneous-require
const puppeteer = require('puppeteer');
// eslint-disable-next-line n/no-unpublished-require
const {installWWebJSSerializerPatch} = require('../dist/wa-patch.js');

const executable = puppeteer.executablePath();
const browserArguments = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--no-zygote',
  '--disable-gpu',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
];

function reportFailure(err) {
  console.error(`Chrome for Testing could not start: ${executable}`);

  const linkedLibraries = spawnSync('ldd', [executable], {encoding: 'utf8'});
  const missingLibraries = String(linkedLibraries.stdout || '')
    .split('\n')
    .filter(line => line.includes('not found'))
    .map(line => line.trim());

  if (missingLibraries.length > 0) {
    console.error('Missing Ubuntu libraries:');
    console.error(missingLibraries.join('\n'));
  } else {
    console.error(err instanceof Error ? err.stack || err.message : err);
  }

  console.error(
    'Install the Ubuntu browser libraries in docs/ubuntu-install.md, then rerun npm run check:browser.'
  );
}

async function main() {
  if (!fs.existsSync(executable)) {
    console.error(`Chrome for Testing is missing: ${executable}`);
    console.error('Run npm ci again and inspect the Puppeteer install output.');
    process.exitCode = 1;
    return;
  }

  let browser;

  try {
    browser = await puppeteer.launch({
      args: browserArguments,
      headless: true,
    });
    const version = await browser.version();
    const page = await browser.newPage();

    await page.evaluate(() => {
      const malformedChat = {
        formattedTitle: 'Recovered chat',
        id: {
          _serialized: '123@c.us',
          server: 'c.us',
          user: '123',
        },
        timestamp: 1234,
        unreadCount: 2,
      };
      const collections = {
        Chat: {getModelsArray: () => [malformedChat]},
      };

      globalThis.require = () => collections;
      globalThis.WWebJS = {
        getChatModel: async () => {
          throw new Error('malformed chat');
        },
        getChats: async () => [],
        getContactModel: contact => ({id: contact.id}),
        getContacts: async () => [null, {id: {_serialized: '123@c.us'}}],
      };
    });

    assert.equal(await page.evaluate(installWWebJSSerializerPatch), true);
    const patchResult = await page.evaluate(async () => {
      const contacts = await globalThis.WWebJS.getContacts();
      const chats = await globalThis.WWebJS.getChats();
      return {
        chatId: chats[0] && chats[0].id && chats[0].id._serialized,
        contacts: contacts.length,
      };
    });
    assert.deepEqual(patchResult, {chatId: '123@c.us', contacts: 1});

    await browser.close();
    browser = undefined;

    console.log(`browser=${executable}`);
    console.log(`version=${version}`);
    console.log('browser-runtime-check=PASS');
  } catch (err) {
    reportFailure(err);
    process.exitCode = 1;
  } finally {
    if (browser) {
      await browser.close().catch(() => undefined);
    }
  }
}

main().catch(err => {
  reportFailure(err);
  process.exitCode = 1;
});

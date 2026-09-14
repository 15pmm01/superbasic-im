'use strict';

const assert = require('assert/strict');
const vm = require('vm');

// This is the freshly compiled function that Puppeteer serializes into the
// WhatsApp Web page. Testing its string form catches missing compiler helpers.
// eslint-disable-next-line n/no-unpublished-require
const {installWWebJSSerializerPatch} = require('../dist/wa-patch.js');

const patchSource = installWWebJSSerializerPatch.toString();

async function runPatch(window) {
  return vm.runInNewContext(`(${patchSource})()`, {console, window});
}

async function main() {
  assert.doesNotMatch(patchSource, /__awaiter/);

  const incompleteWindow = {WWebJS: {}};
  assert.equal(await runPatch(incompleteWindow), false);
  assert.equal(incompleteWindow.WWebJS.__superbasicPatchedModels, undefined);

  const malformedContact = {id: {_serialized: '123@c.us'}};
  const malformedChat = {
    archive: false,
    formattedTitle: 'Recovered chat',
    id: {
      _serialized: '123@c.us',
      server: 'c.us',
      user: '123',
    },
    mute: {expiration: 0},
    pin: false,
    timestamp: 1234,
    unreadCount: 2,
  };
  const collections = {
    Chat: {
      getModelsArray: () => [malformedChat],
    },
  };
  const wWebJS = {
    getChatModel: async () => {
      throw new Error('malformed chat');
    },
    getChats: async () => [],
    getContactModel: contact => ({id: contact.id}),
    getContacts: async () => [null, malformedContact],
  };
  const completeWindow = {
    WWebJS: wWebJS,
    require: name => {
      assert.equal(name, 'WAWebCollections');
      return collections;
    },
  };

  assert.equal(await runPatch(completeWindow), true);
  assert.equal(wWebJS.__superbasicPatchedModels, true);
  assert.equal(wWebJS.getContactModel(null), null);

  const contacts = await wWebJS.getContacts();
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].id._serialized, '123@c.us');

  const chats = await wWebJS.getChats();
  assert.equal(chats.length, 1);
  assert.equal(chats[0].id._serialized, '123@c.us');
  assert.equal(chats[0].formattedTitle, 'Recovered chat');
  assert.equal(chats[0].unreadCount, 2);

  assert.equal(await runPatch(completeWindow), true);
  console.log('whatsapp-browser-serializer-patch-smoke-test=PASS');
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});

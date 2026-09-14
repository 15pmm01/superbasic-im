import fs from 'fs';
import * as emoji from 'node-emoji';
import * as mime from 'mime-types';
import path from 'path';
import * as QRCode from 'qrcode';
import {
  Client as WAClient,
  Contact as WAContact,
  LocalAuth,
  MessageMedia,
} from 'whatsapp-web.js';

import {
  ensureRuntimeDirectories,
  MEDIA_DIR,
  WWJS_AUTH_DIR,
  WWJS_CACHE_DIR,
} from './paths';
import {installWWebJSSerializerPatch} from './wa-patch';

export interface UserContact {
  name: string;
  id: string;
}

interface UploadedFile {
  bytes?: number;
  path?: string;
  filename?: string;
  headers?: Record<string, string | undefined>;
}

let clientDead = false;
let exiting = false;

ensureRuntimeDirectories();

function errorDetails(err: unknown): unknown {
  return err instanceof Error ? err.stack || err.message : err;
}

function isFatalPuppeteerError(err: unknown): boolean {
  const message = String(errorDetails(err) || '');

  return [
    'Attempted to use detached Frame',
    'Execution context was destroyed',
    'Target closed',
    'Session closed',
    'Protocol error',
    "Cannot read properties of null (reading 'evaluate')",
    'Navigation failed because browser has disconnected',
  ].some(fragment => message.includes(fragment));
}

function scheduleHardExit(reason: string, err?: unknown): void {
  if (exiting) return;

  exiting = true;
  clientDead = true;
  console.error(`[WA] FATAL: ${reason}`);

  if (err !== undefined) {
    console.error(errorDetails(err));
  }

  // A clean process restart is the only reliable recovery from a dead browser.
  // eslint-disable-next-line n/no-process-exit
  setTimeout(() => process.exit(1), 250);
}

export function markClientDead(reason: string, err?: unknown): void {
  clientDead = true;
  scheduleHardExit(reason, err);
}

/** Exit so the process manager can restart a fatally broken browser client. */
export async function ensureClient(): Promise<void> {
  if (clientDead) {
    scheduleHardExit('ensureClient called while client is marked dead');
    return;
  }

  try {
    await client.getState();
  } catch (err) {
    if (isFatalPuppeteerError(err)) {
      scheduleHardExit('client.getState fatal in ensureClient()', err);
      return;
    }

    console.error('[WA] ensureClient: getState threw (non-fatal)');
    console.error(errorDetails(err));
  }
}

export const client = new WAClient({
  authStrategy: new LocalAuth({dataPath: WWJS_AUTH_DIR}),
  webVersionCache: {
    type: 'local',
    path: WWJS_CACHE_DIR,
  },
  puppeteer: {
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--no-zygote',
      '--disable-gpu',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ],
  },
});

export let pairQr: string | null = null;
export const unreadChats = new Map<string, number>();

/**
 * Patch WhatsApp Web serializers so malformed contacts and partially loaded
 * group metadata do not make getContacts() or getChats() fail completely.
 */
async function patchWWebJSContactsOnce(): Promise<void> {
  try {
    const page = client.pupPage;

    if (!page) {
      console.error('[WA] patchWWebJSContactsOnce: no pupPage available');
      return;
    }

    let installed = false;

    for (let attempt = 0; attempt < 40; attempt++) {
      // whatsapp-web.js injects WWebJS into the browser page at runtime.
      installed = await page.evaluate(installWWebJSSerializerPatch);
      if (installed) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }

    if (!installed) {
      console.error(
        '[WA] serializer patch unavailable: WWebJS helpers did not become ready'
      );
      return;
    }

    console.log('[WA] Patched malformed WhatsApp contact/chat conversion');
  } catch (err) {
    console.error('[WA] patchWWebJSContactsOnce failed (non-fatal)');
    console.error(errorDetails(err));
  }
}

client.once('ready', async () => {
  console.log('Client is ready!');
  await patchWWebJSContactsOnce();

  try {
    const chats = await client.getChats();

    for (const chat of chats) {
      if (chat.unreadCount > 0) {
        const chatId = encodeURIComponent(chat.id._serialized);
        unreadChats.set(chatId, chat.unreadCount);
      }
    }
  } catch (err) {
    if (isFatalPuppeteerError(err)) {
      scheduleHardExit('fatal during initial getChats() in ready()', err);
      return;
    }

    console.error('[WA] ready(): getChats failed (non-fatal)');
    console.error(errorDetails(err));
  }
});

client.on('qr', qr => {
  console.log('QR code RECEIVED');

  QRCode.toDataURL(qr, (err, url) => {
    if (err) {
      console.error('[WA] QRCode.toDataURL error');
      console.error(errorDetails(err));
      return;
    }

    pairQr = url;
  });
});

client.on('disconnected', reason => {
  scheduleHardExit(`client disconnected: ${reason}`);
});

client.on('auth_failure', message => {
  scheduleHardExit(`auth_failure: ${message}`);
});

client.on('change_state', state => {
  console.log(`[WA] change_state: ${state}`);
});

client.on('message_create', async message => {
  const id = encodeURIComponent(message.id._serialized);

  console.log(
    `new message: ${id} from ${message.author} to ${message.to} at ${message.timestamp}`
  );

  try {
    if (message.hasMedia) {
      const media = await message.downloadMedia();

      if (media) {
        const extension = mime.extension(media.mimetype);
        const mediaPath = path.join(MEDIA_DIR, `${id}.${extension}`);

        fs.writeFile(mediaPath, Buffer.from(media.data, 'base64'), err => {
          if (err) {
            console.log(err);
            return;
          }

          console.log(`The file was saved: ${id}`);
          fs.symlinkSync(mediaPath, path.join(MEDIA_DIR, id), 'file');
        });
      }
    }
  } catch (err) {
    if (isFatalPuppeteerError(err)) {
      scheduleHardExit('fatal during message_create handler', err);
      return;
    }

    console.error('[WA] message_create handler failed (non-fatal)');
    console.error(errorDetails(err));
  }
});

client.on('unread_count', async chat => {
  try {
    const chatId = encodeURIComponent(chat.id._serialized);

    if (chat.unreadCount === 0) {
      unreadChats.delete(chatId);
    } else {
      unreadChats.set(chatId, chat.unreadCount);
    }
  } catch (err) {
    if (isFatalPuppeteerError(err)) {
      scheduleHardExit('fatal during unread_count handler', err);
      return;
    }

    console.error('[WA] unread_count handler failed (non-fatal)');
    console.error(errorDetails(err));
  }
});

export async function getUserContacts(): Promise<UserContact[]> {
  const users: UserContact[] = [];
  let contacts: WAContact[] = [];

  try {
    contacts = await client.getContacts();
  } catch (firstError) {
    console.error('[WA] getContacts() threw; retrying once');
    console.error(errorDetails(firstError));

    try {
      await new Promise(resolve => setTimeout(resolve, 600));
      contacts = await client.getContacts();
    } catch (secondError) {
      console.error('[WA] getContacts() failed again; returning empty list');
      console.error(errorDetails(secondError));
      return users;
    }
  }

  for (const contact of contacts) {
    if (!contact?.isUser || !contact.id?._serialized) continue;

    users.push({
      name: waContactToName(contact, true),
      id: contact.id._serialized,
    });
  }

  users.sort((first, second) => first.name.localeCompare(second.name));
  return users;
}

export function waContactToName(
  contact: WAContact,
  addNumber: boolean
): string {
  let name = contact.name || contact.pushname;

  if (addNumber && contact.isUser) {
    name = `${name} [${contact.number}]`;
  }

  return name ? emoji.unemojify(name) : contact.number;
}

export function longNumToDate(
  noOrLong: number | null | undefined | string,
  locale?: string
): string {
  let date = new Date();

  if (typeof noOrLong === 'number') {
    date = new Date(noOrLong * 1000);
  } else if (typeof noOrLong === 'string') {
    date = new Date(Number.parseInt(noOrLong, 10) * 1000);
  }

  return date.toLocaleString(locale);
}

export async function sendWAMessage(
  to: string,
  message: unknown,
  file: UploadedFile | null | undefined
): Promise<void> {
  const messageText = typeof message === 'string' ? message : '';

  if (messageText.length > 0) {
    await client.sendMessage(to, emoji.emojify(messageText));
  }

  const hasFile =
    file !== null &&
    file !== undefined &&
    Number(file.bytes) > 0 &&
    typeof file.path === 'string';

  if (hasFile && file.path) {
    const media = MessageMedia.fromFilePath(file.path);

    if (typeof file.filename === 'string') {
      media.filename = file.filename;
    }

    const contentType = file.headers?.['content-type'];
    if (typeof contentType === 'string') {
      media.mimetype = contentType;
    }

    await client.sendMessage(to, media);
  }

  if (messageText.length === 0 && !hasFile) {
    throw new Error(
      'Cannot send a WhatsApp message without text or an attachment'
    );
  }
}

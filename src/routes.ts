import {ReqRefDefaults, Request, ResponseToolkit} from '@hapi/hapi';
import fs from 'fs';
import * as emoji from 'node-emoji';
import path from 'path';
import vcards from 'vcards-js';
import {
  Chat,
  Contact,
  GroupChat,
  GroupParticipant,
  Message,
  WAState,
} from 'whatsapp-web.js';

import {
  client,
  ensureClient,
  getUserContacts,
  longNumToDate,
  pairQr,
  sendWAMessage,
  unreadChats,
  waContactToName,
} from './client';
import {removeDiacritics} from './helper';
import {getMessages, getRequestLanguage, LocalizedMessages} from './i18n';
import {MEDIA_DIR} from './paths';
import {
  escapeWml,
  estimateWmlLength,
  getPageNumber,
  isWmlRequest,
  paginateItems,
  renderPage,
  sanitizeWmlText,
} from './presentation';

interface ChatListItem {
  name: string;
  hasUnread: boolean;
  id: string;
}

interface ParticipantListItem {
  id: string;
  encodedId: string;
  contactName: string;
  isAdmin: boolean;
}

interface ChatInfoPageItem {
  isDescription: boolean;
  isParticipant: boolean;
  text: string;
  contactName: string;
  encodedId: string;
  isAdmin: boolean;
}

interface FormattedMessage {
  from: string;
  msg: string[];
  time: string;
  fromMe: boolean;
  media: boolean;
  hasReaction: boolean;
  hasQuotedMessage: boolean;
  id: string;
  repliedMessage: string;
  showDetails: boolean;
  reactionsDetails: string[];
}

function errorDetails(err: unknown): unknown {
  if (err && typeof err === 'object' && 'stack' in err) {
    return (err as {stack?: unknown}).stack || err;
  }

  return err;
}

/**
 * Safely look up a WhatsApp contact.
 *
 * Some partially migrated WhatsApp accounts expose malformed `@lid` IDs.
 * A failed lookup must not turn an otherwise usable page into a silent 500.
 */
async function safeGetContactById(
  id: string,
  context: string
): Promise<Contact | null> {
  try {
    if (!id) {
      console.error(`[WA] getContactById called with empty id (${context})`);
      return null;
    }

    const contact = await client.getContactById(id);
    return contact || null;
  } catch (err) {
    console.error(`[WA] getContactById failed (${context}) id=${id}`);
    console.error(errorDetails(err));
    return null;
  }
}

function chatListFailure(
  request: Request<ReqRefDefaults>,
  h: ResponseToolkit<ReqRefDefaults>
) {
  const messages = getMessages(request);

  if (isWmlRequest(request)) {
    return h
      .response(
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE wml PUBLIC "-//WAPFORUM//DTD WML 1.1//EN"
    "http://www.wapforum.org/DTD/wml_1.1.xml">
<wml>
    <card id="error" title="SuperBasic IM">
        <p>${escapeWml(messages.chatListUnavailable)}</p>
        <p><a href="/">${escapeWml(messages.back)}</a></p>
    </card>
</wml>`
      )
      .code(503)
      .type('text/vnd.wap.wml; charset=utf-8')
      .header('Content-Language', getRequestLanguage(request))
      .header('Vary', 'Accept-Language');
  }

  return h
    .response(
      `<p>${messages.chatListUnavailable}</p>` +
        `<p><a href="/">${messages.back}</a></p>`
    )
    .code(503)
    .type('text/html; charset=utf-8')
    .header('Content-Language', getRequestLanguage(request))
    .header('Vary', 'Accept-Language');
}

function chatListItem(
  chat: Chat,
  name: string,
  messages: LocalizedMessages
): ChatListItem {
  return {
    name:
      name +
      ' (' +
      chat.unreadCount +
      ` ${messages.unread}, ` +
      longNumToDate(chat.timestamp, messages.locale) +
      ')',
    hasUnread: chat.unreadCount > 0,
    id: encodeURIComponent(chat.id._serialized),
  };
}

async function formatChatList(
  chats: Chat[],
  context: 'recent_chats_handler' | 'all_chats_handler',
  messages: LocalizedMessages
): Promise<ChatListItem[]> {
  const formattedChats: ChatListItem[] = [];

  for (const chat of chats) {
    let name = '';

    try {
      const contact = await chat.getContact();
      name = waContactToName(contact, true);
    } catch (err) {
      const chatId = chat.id?._serialized || 'unknown';
      console.error(
        `[WA] chat.getContact failed (${context}) chatId=${chatId}`
      );
      console.error(errorDetails(err));
      name = chat.id?._serialized || messages.unknownChat;
    }

    formattedChats.push(chatListItem(chat, name, messages));
  }

  return formattedChats;
}

function renderWmlChatList(
  request: Request<ReqRefDefaults>,
  h: ResponseToolkit<ReqRefDefaults>,
  chats: ChatListItem[],
  listPath: string
) {
  const pagination = paginateItems(chats, getPageNumber(request), {
    separatorLength: 80,
    estimateItem: chat =>
      estimateWmlLength(chat.name) + estimateWmlLength(chat.id),
  });

  return renderPage(request, h, 'index', {
    chats: pagination.items,
    listPath,
    page: pagination.page,
    totalPages: pagination.totalPages,
    totalItems: pagination.totalItems,
    hasPreviousPage: pagination.hasPreviousPage,
    hasNextPage: pagination.hasNextPage,
    previousPage: pagination.previousPage,
    nextPage: pagination.nextPage,
  });
}

export const vcard_handler = async (
  request: Request<ReqRefDefaults>,
  h: ResponseToolkit<ReqRefDefaults>
) => {
  const vcard = vcards();
  const contact = await safeGetContactById(
    request.params.chat_id,
    'vcard_handler'
  );

  if (!contact) {
    return h
      .response(getMessages(request).contactNotAvailable)
      .code(404)
      .header('Content-Language', getRequestLanguage(request))
      .header('Vary', 'Accept-Language');
  }

  const name = waContactToName(contact, false);
  const split = name.split(' ', 2);
  vcard.firstName = split[0];

  if (split.length > 1) {
    vcard.lastName = split[1];
  }

  vcard.cellPhone = '+' + contact.number;

  // Some phones have issues with diacritics in filenames.
  const filename = removeDiacritics(vcard.firstName + '_' + vcard.lastName);

  return h
    .response(vcard.getFormattedString())
    .header('Content-Type', 'text/vcard; name="' + filename + '.vcf"')
    .header('Content-Disposition', 'inline; filename="' + filename + '.vcf"');
};

export const reply_handler = async (
  request: Request<ReqRefDefaults>,
  h: ResponseToolkit<ReqRefDefaults>
) => {
  // TODO: give proper types
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payload = request.payload as any;
  await sendWAMessage(request.params.chat_id, payload.message, payload.file);

  return h.redirect('/chats/' + request.params.chat_id);
};

export const read_all_handler = async (
  request: Request<ReqRefDefaults>,
  h: ResponseToolkit<ReqRefDefaults>
) => {
  await client.sendSeen(request.params.chat_id);
  return h.redirect('/chats/' + request.params.chat_id);
};

export const new_chat_post_handler = async (
  request: Request<ReqRefDefaults>,
  h: ResponseToolkit<ReqRefDefaults>
) => {
  // TODO: give proper types
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payload = request.payload as any;
  let to = payload.user;

  if (to === 'custom') {
    const number = payload.custom;
    const contact = await client.getNumberId(number);

    if (contact === null) {
      console.log('invalid number: ' + number);
      return h.redirect('/');
    }

    to = contact._serialized;
  }

  await sendWAMessage(to, payload.message, payload.file);
  return h.redirect('/chats/' + to);
};

export const recent_chats_handler = async (
  request: Request<ReqRefDefaults>,
  h: ResponseToolkit<ReqRefDefaults>
) => {
  await ensureClient();

  let chats: Chat[] = [];

  try {
    chats = await client.getChats();
  } catch (err) {
    console.error('[WA] getChats failed in chat-list handler');
    console.error(errorDetails(err));
    return chatListFailure(request, h);
  }

  chats.sort((a, b) => b.timestamp - a.timestamp);
  const formattedChats = await formatChatList(
    chats.slice(0, 20),
    'recent_chats_handler',
    getMessages(request)
  );

  if (!isWmlRequest(request)) {
    return renderPage(request, h, 'index', {chats: formattedChats});
  }

  return renderWmlChatList(request, h, formattedChats, '/recentchats');
};

export const all_chats_handler = async (
  request: Request<ReqRefDefaults>,
  h: ResponseToolkit<ReqRefDefaults>
) => {
  await ensureClient();

  let chats: Chat[] = [];

  try {
    chats = await client.getChats();
  } catch (err) {
    console.error('[WA] getChats failed in all_chats_handler');
    console.error(errorDetails(err));
    return chatListFailure(request, h);
  }

  chats.sort((a, b) => b.timestamp - a.timestamp);
  const formattedChats = await formatChatList(
    chats,
    'all_chats_handler',
    getMessages(request)
  );

  if (!isWmlRequest(request)) {
    return renderPage(request, h, 'index', {chats: formattedChats});
  }

  return renderWmlChatList(request, h, formattedChats, request.path);
};

/**
 * Show the full WhatsApp contact list.
 *
 * HTML keeps the existing unpaginated contacts page. WML uses a character
 * budget so the generated deck remains small enough for older mobile browsers.
 */
export const contacts_handler = async (
  request: Request<ReqRefDefaults>,
  h: ResponseToolkit<ReqRefDefaults>
) => {
  await ensureClient();
  const users = await getUserContacts();

  if (!isWmlRequest(request)) {
    return renderPage(request, h, 'contacts', {users});
  }

  const pagination = paginateItems(users, getPageNumber(request), {
    separatorLength: 140,
    estimateItem: user =>
      estimateWmlLength(user.name) + estimateWmlLength(user.id),
  });

  return renderPage(request, h, 'contacts', {
    users: pagination.items,
    page: pagination.page,
    totalPages: pagination.totalPages,
    totalItems: pagination.totalItems,
    hasPreviousPage: pagination.hasPreviousPage,
    hasNextPage: pagination.hasNextPage,
    previousPage: pagination.previousPage,
    nextPage: pagination.nextPage,
  });
};

export const media_handler = async (
  request: Request<ReqRefDefaults>,
  h: ResponseToolkit<ReqRefDefaults>
) => {
  const id = encodeURIComponent(request.params.media_id);
  const messages = getMessages(request);

  try {
    if (fs.readdirSync(MEDIA_DIR).includes(id)) {
      const mediaPath = fs.readlinkSync(path.join(MEDIA_DIR, id));
      return h.file(mediaPath);
    }

    return h
      .response(messages.fileNotFound)
      .code(404)
      .header('Content-Language', getRequestLanguage(request))
      .header('Vary', 'Accept-Language');
  } catch (err) {
    console.log(err);
    return h
      .response(messages.fileNotFound)
      .code(404)
      .header('Content-Language', getRequestLanguage(request))
      .header('Vary', 'Accept-Language');
  }
};

export const chat_info_handler = async (
  request: Request<ReqRefDefaults>,
  h: ResponseToolkit<ReqRefDefaults>
) => {
  const messages = getMessages(request);
  let chatName = '';
  let chatDescription: string[] = [];
  const chat = await client.getChatById(request.params.chat_id);

  if (!chat || !chat.isGroup) {
    return h
      .response(messages.chatNotGroup)
      .code(400)
      .header('Content-Language', getRequestLanguage(request))
      .header('Vary', 'Accept-Language');
  }

  const groupChat = chat as GroupChat;
  const participantList: ParticipantListItem[] = [];

  try {
    chatName = typeof groupChat.name === 'string' ? groupChat.name : '';
  } catch (err) {
    console.error(
      `[WA] group name lookup failed (chat_info_handler) chatId=${request.params.chat_id}`
    );
    console.error(errorDetails(err));
    chatName = '';
  }

  try {
    const description = groupChat.description;

    if (typeof description === 'string' && description.length > 0) {
      chatDescription = description.split('\n');
    }
  } catch (err) {
    console.error(
      `[WA] group description lookup failed (chat_info_handler) chatId=${request.params.chat_id}`
    );
    console.error(errorDetails(err));
    chatDescription = [];
  }

  let participants: GroupParticipant[] = [];

  try {
    const groupParticipants = groupChat.participants;
    if (Array.isArray(groupParticipants)) participants = groupParticipants;
  } catch (err) {
    console.error(
      `[WA] group participants lookup failed (chat_info_handler) chatId=${request.params.chat_id}`
    );
    console.error(errorDetails(err));
    participants = [];
  }

  for (const participant of participants) {
    const participantId = participant?.id?._serialized || '';
    const contact = participantId
      ? await safeGetContactById(participantId, 'chat_info_handler participant')
      : null;

    participantList.push({
      id: participantId,
      encodedId: participantId ? encodeURIComponent(participantId) : '',
      contactName: contact
        ? waContactToName(contact, false)
        : participantId || messages.unknown,
      isAdmin: participant?.isAdmin === true,
    });
  }

  const formattedChatName = emoji.unemojify(chatName || messages.groupChat);
  const formattedDescription = chatDescription.map(line =>
    emoji.unemojify(line)
  );

  if (!isWmlRequest(request)) {
    return renderPage(request, h, 'chatinfo', {
      chatId: request.params.chat_id,
      chatName: formattedChatName,
      chatDescription: formattedDescription,
      participants: participantList,
    });
  }

  const wmlChatName = sanitizeWmlText(formattedChatName);
  const wmlDescription = formattedDescription.map(line =>
    sanitizeWmlText(line)
  );

  /*
   * paginateItems() keeps a complete item together even when that item exceeds
   * the page budget. Split a single enormous description line first so it
   * cannot produce a WML deck that is too large for an older phone.
   */
  const splitDescriptionLine = (line: string): string[] => {
    const source = String(line || '');
    if (!source) return [''];

    const chunks: string[] = [];
    let chunk = '';

    for (const character of source) {
      const candidate = chunk + character;

      if (chunk && estimateWmlLength(candidate) > 1200) {
        chunks.push(chunk);
        chunk = character;
      } else {
        chunk = candidate;
      }
    }

    if (chunk) chunks.push(chunk);
    return chunks;
  };

  const pageItems: ChatInfoPageItem[] = [];

  for (const description of wmlDescription) {
    for (const chunk of splitDescriptionLine(description)) {
      pageItems.push({
        isDescription: true,
        isParticipant: false,
        text: chunk,
        contactName: '',
        encodedId: '',
        isAdmin: false,
      });
    }
  }

  for (const participant of participantList) {
    pageItems.push({
      isDescription: false,
      isParticipant: true,
      text: '',
      contactName: sanitizeWmlText(participant.contactName),
      encodedId: participant.encodedId,
      isAdmin: participant.isAdmin,
    });
  }

  const pagination = paginateItems(pageItems, getPageNumber(request), {
    separatorLength: 100,
    estimateItem: item => {
      if (item.isDescription) return estimateWmlLength(item.text);

      return (
        estimateWmlLength(item.contactName) +
        estimateWmlLength(item.encodedId) +
        (item.isAdmin ? 20 : 0)
      );
    },
  });

  return renderPage(request, h, 'chatinfo', {
    chatId: encodeURIComponent(request.params.chat_id),
    chatName: wmlChatName,
    items: pagination.items,
    hasDescription: wmlDescription.length > 0,
    hasParticipants: participantList.length > 0,
    page: pagination.page,
    totalPages: pagination.totalPages,
    totalItems: pagination.totalItems,
    hasPreviousPage: pagination.hasPreviousPage,
    hasNextPage: pagination.hasNextPage,
    previousPage: pagination.previousPage,
    nextPage: pagination.nextPage,
  });
};

export const chat_handler = async (
  request: Request<ReqRefDefaults>,
  h: ResponseToolkit<ReqRefDefaults>,
  loadAllUnreadMessages: boolean
) => {
  const localized = getMessages(request);
  const chat = await client.getChatById(request.params.chat_id);
  const unreadMessages = chat.unreadCount > 0;
  let tooManyUnreadMessages = chat.unreadCount >= 51;
  let messages: Message[];

  if (loadAllUnreadMessages) {
    messages = await chat.fetchMessages({limit: chat.unreadCount});
    tooManyUnreadMessages = false;
  } else if (chat.unreadCount > 10 && chat.unreadCount < 51) {
    messages = await chat.fetchMessages({limit: chat.unreadCount});
  } else if (chat.unreadCount >= 51) {
    messages = await chat.fetchMessages({limit: 50});
  } else {
    messages = await chat.fetchMessages({limit: 10});
  }

  const formattedMessages: FormattedMessage[] = [];

  for (const message of messages) {
    const body = typeof message.body === 'string' ? message.body : '';
    const messageLines = body
      ? body.split('\n').map(line => emoji.unemojify(line))
      : [];
    const fromMe = message.fromMe === true;
    const nameId = message.author || message.from || '';
    const contact = await safeGetContactById(
      nameId,
      'chat_handler message author/from'
    );
    const name = contact
      ? waContactToName(contact, false)
      : nameId || localized.unknown;
    const rawMessageId =
      message.id &&
      typeof message.id._serialized === 'string' &&
      message.id._serialized.length > 0
        ? message.id._serialized
        : '';
    const encodedMessageId = rawMessageId
      ? encodeURIComponent(rawMessageId)
      : '';
    let repliedMessageInfo = '';
    let hasQuotedMessage = false;
    const reactions: string[] = [];

    if (message.hasQuotedMsg && rawMessageId) {
      try {
        const repliedMessage = await message.getQuotedMessage();

        if (repliedMessage) {
          const repliedNameId =
            repliedMessage.author || repliedMessage.from || '';
          const repliedContact = await safeGetContactById(
            repliedNameId,
            'chat_handler quoted author/from'
          );
          const repliedName = repliedContact
            ? waContactToName(repliedContact, false)
            : repliedNameId || localized.unknown;
          const repliedBody =
            typeof repliedMessage.body === 'string'
              ? emoji.unemojify(repliedMessage.body)
              : '';

          repliedMessageInfo =
            repliedName +
            ' (' +
            longNumToDate(repliedMessage.timestamp, localized.locale) +
            '): ' +
            repliedBody;
          hasQuotedMessage = repliedMessageInfo.length > 0;
        }
      } catch (err) {
        console.error(
          `[WA] quoted message handling failed (chat_handler) msgId=${
            rawMessageId || 'unknown'
          }`
        );
        console.error(errorDetails(err));
      }
    }

    if (message.hasReaction && rawMessageId) {
      try {
        const reactionsList = await message.getReactions();

        for (const reaction of reactionsList) {
          let reactionInfo =
            emoji.unemojify(reaction.id || '') + ` ${localized.by}: `;
          const senderNames: string[] = [];

          for (const sender of reaction.senders) {
            const senderId = sender.senderId;
            const reactionContact = await safeGetContactById(
              senderId,
              'chat_handler reaction sender'
            );
            senderNames.push(
              reactionContact
                ? waContactToName(reactionContact, false)
                : senderId || localized.unknown
            );
          }

          reactionInfo += senderNames.join(', ');
          reactions.push(reactionInfo);
        }
      } catch (err) {
        console.error(
          `[WA] reaction handling failed (chat_handler) msgId=${
            rawMessageId || 'unknown'
          }`
        );
        console.error(errorDetails(err));
      }
    }

    const hasReaction = reactions.length > 0;
    const hasMedia = message.hasMedia === true && encodedMessageId.length > 0;

    formattedMessages.push({
      from: name,
      msg: messageLines,
      time: longNumToDate(message.timestamp, localized.locale),
      fromMe,
      media: hasMedia,
      hasReaction,
      hasQuotedMessage,
      id: encodedMessageId,
      repliedMessage: repliedMessageInfo,
      showDetails: hasReaction || hasQuotedMessage,
      reactionsDetails: reactions,
    });
  }

  if (formattedMessages.length === 0) {
    formattedMessages.push({
      from: localized.noMessages,
      msg: [localized.noMessages],
      time: '',
      fromMe: false,
      media: false,
      hasReaction: false,
      hasQuotedMessage: false,
      id: '',
      repliedMessage: '',
      showDetails: false,
      reactionsDetails: [],
    });
  }

  const viewModel = {
    messages: formattedMessages,
    chat_unreadMessages: unreadMessages,
    chat_tooManyUnreadMessages: tooManyUnreadMessages,
    amountUnreadMessages: chat.unreadCount,
    chat_id: encodeURIComponent(request.params.chat_id),
    groupChat: chat.isGroup,
  };

  if (!isWmlRequest(request)) {
    return renderPage(request, h, 'chats', viewModel);
  }

  return renderPage(request, h, 'chats', viewModel);
};

/**
 * The HTML start page keeps the full contact dropdown. WML omits that list so
 * the generated deck stays small enough for older browsers and WAP gateways.
 */
export const new_chat_or_pair_handler = async (
  request: Request<ReqRefDefaults>,
  h: ResponseToolkit<ReqRefDefaults>
) => {
  const useWml = isWmlRequest(request);
  const localized = getMessages(request);
  let state: WAState;

  try {
    state = await client.getState();
  } catch (err) {
    console.error(
      '[WA] getState failed; restarting stale WhatsApp client process'
    );
    console.error(errorDetails(err));

    setTimeout(() => {
      // A clean process restart is the only reliable recovery here.
      // eslint-disable-next-line n/no-process-exit
      process.exit(1);
    }, 1000);

    if (useWml) {
      return h
        .response(
          `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE wml PUBLIC "-//WAPFORUM//DTD WML 1.1//EN"
    "http://www.wapforum.org/DTD/wml_1.1.xml">
<wml>
    <card id="error" title="SuperBasic IM">
        <p>${escapeWml(localized.whatsappRestarting)}</p>
        <p><a href="/">${escapeWml(localized.retry)}</a></p>
    </card>
</wml>`
        )
        .code(503)
        .type('text/vnd.wap.wml; charset=utf-8')
        .header('Content-Language', getRequestLanguage(request))
        .header('Vary', 'Accept-Language');
    }

    return h
      .response(
        `<p>${localized.whatsappRestarting}</p>` +
          `<p><a href="/">${localized.retry}</a></p>`
      )
      .code(503)
      .type('text/html; charset=utf-8')
      .header('Content-Language', getRequestLanguage(request))
      .header('Vary', 'Accept-Language');
  }

  if (state !== WAState.CONNECTED) {
    console.log('state: ' + state);

    if (useWml) {
      return renderPage(request, h, 'pair-required', {
        htmlHost: String(process.env.SUPERBASIC_HTML_HOST || '').trim(),
      });
    }

    return renderPage(request, h, 'pair', {qr: pairQr});
  }

  await ensureClient();

  let totalUnreadMessages = 0;
  unreadChats.forEach(value => {
    totalUnreadMessages += value;
  });

  if (useWml) {
    return renderPage(request, h, 'new', {totalUnreadMessages});
  }

  const users = await getUserContacts();
  return renderPage(request, h, 'new', {users, totalUnreadMessages});
};

/**
 * Install the serializer compatibility patch inside the WhatsApp Web page.
 *
 * Puppeteer serializes this function and executes it in the browser, so it
 * must remain self-contained: do not reference imports or module variables.
 */
export async function installWWebJSSerializerPatch(): Promise<boolean> {
  // These are private WhatsApp Web/whatsapp-web.js browser globals.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const waWindow = window as any;
  const wWebJS = waWindow.WWebJS;

  if (wWebJS?.__superbasicPatchedModels) return true;

  const requiredMethods = [
    'getChats',
    'getChatModel',
    'getContacts',
    'getContactModel',
  ];

  if (
    !wWebJS ||
    typeof waWindow.require !== 'function' ||
    requiredMethods.some(name => typeof wWebJS[name] !== 'function')
  ) {
    return false;
  }

  const originalGetContacts = wWebJS.getContacts;
  const originalGetContactModel = wWebJS.getContactModel;
  const originalGetChatModel = wWebJS.getChatModel;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wWebJS.getContactModel = (contact: any) => {
    try {
      if (!contact || !contact.id) return null;
      return originalGetContactModel(contact);
    } catch (_err) {
      return null;
    }
  };

  wWebJS.getContacts = async () => {
    const raw = await originalGetContacts();
    return Array.isArray(raw) ? raw.filter(Boolean) : raw;
  };

  wWebJS.getChatModel = async (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    chat: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    options: any
  ) => {
    if (!chat || !chat.id) return null;

    const serializedId =
      chat.id._serialized ||
      (chat.id.user && chat.id.server
        ? `${chat.id.user}@${chat.id.server}`
        : String(chat.id));
    const isGroupId =
      typeof serializedId === 'string' && serializedId.endsWith('@g.us');

    if (isGroupId && !chat.groupMetadata) {
      try {
        const collections = waWindow.require('WAWebCollections');
        const groupMetadataCollection =
          collections.GroupMetadata || collections.WAWebGroupMetadataCollection;
        const chatWid = waWindow
          .require('WAWebWidFactory')
          .createWid(serializedId);

        if (typeof groupMetadataCollection?.update === 'function') {
          await groupMetadataCollection.update(chatWid);
        }

        const refreshedChat = collections.Chat.get(serializedId);
        if (refreshedChat) chat = refreshedChat;
      } catch (err) {
        console.warn(
          `[WA] group metadata prefetch failed for ${serializedId}`,
          err
        );
      }
    }

    try {
      return await originalGetChatModel(chat, options);
    } catch (_err) {
      const id = {
        server: chat.id.server,
        user: chat.id.user,
        _serialized: serializedId,
      };

      if (!id._serialized) return null;

      let timestamp = Number(chat.timestamp) || 0;
      if (!timestamp && chat.lastMessage) {
        timestamp = Number(chat.lastMessage.timestamp) || 0;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let serializedGroupMetadata: any = null;

      if (isGroupId && chat.groupMetadata) {
        try {
          serializedGroupMetadata =
            typeof chat.groupMetadata.serialize === 'function'
              ? chat.groupMetadata.serialize()
              : chat.groupMetadata;
          const participants = Array.isArray(
            serializedGroupMetadata?.participants
          )
            ? serializedGroupMetadata.participants
            : [];

          try {
            const lidMigration = waWindow.require('WAWebLidMigrationUtils');

            if (typeof lidMigration?.toPn === 'function') {
              for (const participant of participants) {
                if (participant?.id) {
                  participant.id =
                    lidMigration.toPn(participant.id) || participant.id;
                }
              }
            }
          } catch (_conversionErr) {
            // LID conversion is helpful but not required for valid data.
          }
        } catch (metadataErr) {
          console.warn(
            `[WA] group metadata serialization failed for ${serializedId}`,
            metadataErr
          );
          serializedGroupMetadata = null;
        }
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const model: any = {
        id,
        name:
          chat.name ||
          chat.formattedTitle ||
          chat.contact?.name ||
          chat.contact?.pushname ||
          id.user ||
          id._serialized,
        formattedTitle:
          chat.formattedTitle ||
          chat.name ||
          chat.contact?.name ||
          chat.contact?.pushname ||
          id.user ||
          id._serialized,
        unreadCount: Number(chat.unreadCount) || 0,
        timestamp,
        archived: Boolean(chat.archive),
        pinned: Boolean(chat.pin),
        isGroup: isGroupId || Boolean(serializedGroupMetadata),
        isReadOnly: Boolean(serializedGroupMetadata?.announce),
        isMuted: Boolean(chat.mute && chat.mute.expiration !== 0),
        lastMessage: null,
      };

      if (serializedGroupMetadata) {
        model.groupMetadata = serializedGroupMetadata;
      }

      return model;
    }
  };

  wWebJS.getChats = async () => {
    const chats = waWindow.require('WAWebCollections').Chat.getModelsArray();
    const models = await Promise.all(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      chats.map((chat: any) => wWebJS.getChatModel(chat))
    );

    return models.filter(Boolean);
  };

  wWebJS.__superbasicPatchedModels = true;
  return true;
}

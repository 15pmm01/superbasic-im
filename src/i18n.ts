import {Request} from '@hapi/hapi';

export type Language = 'de' | 'en';

export interface LocalizedMessages {
  back: string;
  backToLogin: string;
  by: string;
  chatListUnavailable: string;
  chatNotGroup: string;
  contactNotAvailable: string;
  fileNotFound: string;
  groupChat: string;
  invalidCredentials: string;
  loginFailed: string;
  locale: string;
  noMessages: string;
  retry: string;
  unknown: string;
  unknownChat: string;
  unread: string;
  whatsappRestarting: string;
}

interface LanguagePreference {
  index: number;
  quality: number;
  tag: string;
}

const translations: Record<Language, LocalizedMessages> = {
  de: {
    back: 'Zurück',
    backToLogin: 'Zurück zur Anmeldung',
    by: 'von',
    chatListUnavailable: 'WhatsApp konnte die Chatliste nicht laden.',
    chatNotGroup: 'Dieser Chat ist keine Gruppe.',
    contactNotAvailable: 'Kontakt nicht verfügbar',
    fileNotFound: 'Datei nicht gefunden',
    groupChat: 'Gruppenchat',
    invalidCredentials: 'Telefonnummer oder Passwort ist falsch.',
    loginFailed: 'Anmeldung fehlgeschlagen.',
    locale: 'de-DE',
    noMessages: 'Keine Nachrichten',
    retry: 'Erneut versuchen',
    unknown: 'Unbekannt',
    unknownChat: 'Unbekannter Chat',
    unread: 'ungelesen',
    whatsappRestarting: 'Die WhatsApp-Verbindung wird neu gestartet.',
  },
  en: {
    back: 'Back',
    backToLogin: 'Back to login',
    by: 'by',
    chatListUnavailable: 'WhatsApp could not load the chat list.',
    chatNotGroup: 'This chat is not a group.',
    contactNotAvailable: 'Contact not available',
    fileNotFound: 'File not found',
    groupChat: 'Group chat',
    invalidCredentials: 'The phone number or password is incorrect.',
    loginFailed: 'Login failed.',
    locale: 'en-US',
    noMessages: 'No messages',
    retry: 'Try again',
    unknown: 'Unknown',
    unknownChat: 'Unknown chat',
    unread: 'unread',
    whatsappRestarting: 'The WhatsApp connection is restarting.',
  },
};

function forcedLanguage(): Language | null {
  const configured = String(process.env.SUPERBASIC_LANGUAGE || '')
    .trim()
    .toLowerCase();

  return configured === 'de' || configured === 'en' ? configured : null;
}

function parseLanguagePreferences(header: string): LanguagePreference[] {
  return header
    .split(',')
    .map((entry, index) => {
      const parts = entry.trim().toLowerCase().split(';');
      const tag = parts.shift() || '';
      let quality = 1;

      for (const parameter of parts) {
        const match = parameter.trim().match(/^q=([0-9.]+)$/);
        if (match) quality = Number.parseFloat(match[1]);
      }

      return {
        index,
        quality: Number.isFinite(quality) ? quality : 0,
        tag,
      };
    })
    .filter(preference => preference.tag && preference.quality > 0)
    .sort(
      (left, right) => right.quality - left.quality || left.index - right.index
    );
}

/** Select a supported language from configuration or Accept-Language. */
export function getRequestLanguage(request: Request): Language {
  const configured = forcedLanguage();
  if (configured) return configured;

  const header =
    typeof request.headers['accept-language'] === 'string'
      ? request.headers['accept-language']
      : '';

  for (const preference of parseLanguagePreferences(header)) {
    if (preference.tag === 'de' || preference.tag.startsWith('de-')) {
      return 'de';
    }

    if (preference.tag === 'en' || preference.tag.startsWith('en-')) {
      return 'en';
    }
  }

  return 'en';
}

export function getMessages(request: Request): LocalizedMessages {
  return translations[getRequestLanguage(request)];
}

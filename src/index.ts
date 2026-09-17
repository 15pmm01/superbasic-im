import * as Cookie from '@hapi/cookie';
import * as Crumb from '@hapi/crumb';
import Hapi, {Request, Server} from '@hapi/hapi';
import * as Inert from '@hapi/inert';
import * as Vision from '@hapi/vision';
import * as argon2 from 'argon2';
import {randomBytes} from 'crypto';
import fs from 'fs';
import * as handlebars from 'handlebars';
import readline from 'readline';
import {WAState} from 'whatsapp-web.js';

import {client, markClientDead, pairQr} from './client';
import {getMessages, getRequestLanguage} from './i18n';
import {
  ensureRuntimeDirectories,
  PUBLIC_DIR,
  USER_CONFIG_PATH,
  VIEWS_DIR,
} from './paths';
import {escapeWml, isWmlRequest, renderPage} from './presentation';
import {
  all_chats_handler,
  chat_handler,
  chat_info_handler,
  contacts_handler,
  media_handler,
  new_chat_or_pair_handler,
  new_chat_post_handler,
  read_all_handler,
  recent_chats_handler,
  reply_handler,
  vcard_handler,
} from './routes';

interface UserConfiguration {
  phoneNumber: string;
  hash: string;
  cookieKey: string;
}

interface LoginPayload {
  username?: unknown;
  password?: unknown;
  crumb?: unknown;
}

interface ResponseDetails {
  isBoom?: boolean;
  message?: string;
  stack?: string;
  statusCode?: number;
  output?: {
    statusCode?: number;
    [key: string]: unknown;
  };
}

function errorDetails(err: unknown): unknown {
  if (err && typeof err === 'object' && 'stack' in err) {
    return (err as {stack?: unknown}).stack || err;
  }

  return err;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch (_err) {
    return '[unstringifiable]';
  }
}

function logRequestLine(request: Request, statusCode: number): void {
  const ip = request.info?.remoteAddress || '-';
  const method = request.method ? request.method.toUpperCase() : '-';
  const requestPath = request.path || request.url?.pathname || '-';
  console.error(`[REQ] ${ip} ${method} ${requestPath} -> ${statusCode}`);
}

function loginPayload(request: Request): LoginPayload | null {
  if (typeof request.payload !== 'object' || request.payload === null) {
    return null;
  }

  return request.payload as LoginPayload;
}

function requestCrumb(request: Request): unknown {
  return (request.plugins as Record<string, unknown>).crumb;
}

export let server: Server;

export const init = async function (): Promise<Server> {
  ensureRuntimeDirectories();
  const user = JSON.parse(
    fs.readFileSync(USER_CONFIG_PATH, 'utf8')
  ) as UserConfiguration;

  server = Hapi.server({
    port: process.env.PORT || 4000,
    host: process.env.HOST || '0.0.0.0',
    routes: {
      cors: {
        credentials: true,
      },
    },
  });

  /*
   * Normalize duplicate cookies before Crumb parses them. Some old browsers
   * and WAP gateways resend the same cookie more than once.
   */
  server.ext('onRequest', (request, h) => {
    if (request.headers.cookie) {
      const cookies = new Map<string, string>();

      String(request.headers.cookie)
        .split(/[;,]/)
        .map((part: string) => part.trim())
        .filter((part: string) => part && !part.startsWith('$'))
        .forEach((part: string) => {
          const separator = part.indexOf('=');
          if (separator === -1) return;

          const name = part.slice(0, separator).trim();
          const value = part.slice(separator + 1).trim();

          if (name && !cookies.has(name)) cookies.set(name, value);
        });

      request.headers.cookie = Array.from(cookies.entries())
        .map(([name, value]) => `${name}=${value}`)
        .join('; ');
    }

    return h.continue;
  });

  /* Log Boom failures and any non-Boom response with a 5xx status. */
  server.ext('onPreResponse', (request, h) => {
    const response = request.response as unknown as ResponseDetails;

    if (response?.isBoom) {
      const statusCode = response.output?.statusCode || 500;
      console.error(
        `[BOOM] ${request.method.toUpperCase()} ${request.path} -> ${statusCode}`
      );

      if (response.message)
        console.error(`[BOOM] message: ${response.message}`);
      if (response.stack) console.error(response.stack);

      try {
        console.error(`[BOOM] output: ${safeStringify(response.output)}`);
      } catch (_err) {
        // Logging must never replace the application's actual response.
      }
    } else if (response?.statusCode && response.statusCode >= 500) {
      console.error(
        `[RESP>=500] ${request.method.toUpperCase()} ${request.path} -> ${response.statusCode}`
      );
    }

    return h.continue;
  });

  /* Always record the request method, path, remote address, and final status. */
  server.events.on('response', request => {
    const response = request.response as unknown as ResponseDetails;
    const statusCode =
      response?.output?.statusCode || response?.statusCode || 0;
    logRequestLine(request, statusCode);
  });

  await server.register([Inert, Vision, Cookie]);
  await server.register({
    plugin: Crumb,
    options: {
      cookieOptions: {
        path: '/',
        isSameSite: false,
        isHttpOnly: false,
      },
    },
  });

  server.auth.strategy('session', 'cookie', {
    cookie: {
      name: 'sid',
      password: user.cookieKey,
      isSecure: process.env.NODE_ENV === 'production',
      isHttpOnly: false,
      isSameSite: false,
      path: '/',
    },
    redirectTo: '/login',
    validate: async (_request, session) => {
      const savedSession = session as {id?: unknown};
      return {isValid: savedSession.id === user.phoneNumber};
    },
  });

  server.auth.default('session');

  /*
   * Do not touch WhatsApp for unauthenticated requests. For authenticated
   * pages, redirect a broken or unpaired client to the pairing/index flow.
   */
  server.ext('onPostAuth', async (request, h) => {
    if (request.auth?.isAuthenticated !== true) return h.continue;

    if (
      request.path !== '/login' &&
      request.path !== '/' &&
      !request.path.startsWith('/public')
    ) {
      let state: WAState | null = null;

      try {
        state = await client.getState();
      } catch (err) {
        console.error(
          `[onRequest] client.getState() threw for ${request.method.toUpperCase()} ${request.path}`
        );
        console.error(errorDetails(err));
        return h.redirect('/').takeover();
      }

      if (state !== WAState.CONNECTED && pairQr !== null) {
        return h.redirect('/').takeover();
      }
    }

    return h.continue;
  });

  server.views({
    engines: {
      html: handlebars,
      wml: handlebars,
    },
    path: VIEWS_DIR,
    defaultExtension: 'html',
  });

  server.route({
    method: 'GET',
    path: '/public/{param*}',
    handler: {
      directory: {
        path: PUBLIC_DIR,
      },
    },
    options: {
      auth: false,
    },
  });

  server.route([
    {
      method: 'GET',
      path: '/login',
      handler: function (request, h) {
        return renderPage(request, h, 'login', {
          crumb: requestCrumb(request),
        });
      },
      options: {
        auth: false,
      },
    },
    {
      method: 'POST',
      path: '/login',
      handler: async (request, h) => {
        const language = getRequestLanguage(request);
        const messages = getMessages(request);
        const payload = loginPayload(request);

        if (payload) {
          try {
            const {username, password} = payload;

            if (
              username === user.phoneNumber &&
              typeof password === 'string' &&
              (await argon2.verify(user.hash, password))
            ) {
              request.cookieAuth.set({id: username});
              return h.redirect('/');
            }
          } catch (err) {
            console.error(err);
          }
        }

        if (isWmlRequest(request)) {
          return h
            .response(
              `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE wml PUBLIC "-//WAPFORUM//DTD WML 1.1//EN"
    "http://www.wapforum.org/DTD/wml_1.1.xml">
<wml>
    <card id="login-failed" title="SuperBasic IM">
        <p>
            ${escapeWml(messages.loginFailed)}
        </p>

        <p>
            ${escapeWml(messages.invalidCredentials)}
        </p>

        <p>
            <a href="/login">${escapeWml(messages.retry)}</a>
        </p>
    </card>
</wml>`
            )
            .code(401)
            .type('text/vnd.wap.wml; charset=utf-8')
            .header('Content-Language', language)
            .header('Vary', 'Accept-Language');
        }

        return h
          .response(
            `<!doctype html>
<html lang="${language}">
<meta name="robots" content="noindex, nofollow, noarchive">
<meta http-equiv="refresh" content="5;url=/login">
<p>${messages.loginFailed}</p>
<p>${messages.invalidCredentials}</p>
<p><a href="/login">${messages.backToLogin}</a></p>
</html>`
          )
          .code(401)
          .type('text/html; charset=utf-8')
          .header('Content-Language', language)
          .header('Vary', 'Accept-Language');
      },
      options: {
        auth: {
          mode: 'try',
        },
      },
    },
    {
      method: 'GET',
      path: '/chats/{chat_id}/vcard',
      handler: vcard_handler,
    },
    {
      method: 'GET',
      path: '/chats/{chat_id}/seen',
      handler: read_all_handler,
    },
    {
      method: 'POST',
      path: '/chats/{chat_id}/reply',
      options: {
        payload: {
          maxBytes: 1024 * 1024 * 5,
          multipart: {
            output: 'file',
          },
          parse: true,
        },
      },
      handler: reply_handler,
    },
    {
      method: 'POST',
      path: '/new-chat',
      options: {
        payload: {
          maxBytes: 1024 * 1024 * 5,
          multipart: {
            output: 'file',
          },
          parse: true,
        },
      },
      handler: new_chat_post_handler,
    },
    {
      method: 'GET',
      path: '/chats',
      handler: all_chats_handler,
    },
    {
      method: 'GET',
      path: '/recentchats',
      handler: recent_chats_handler,
    },
    {
      method: 'GET',
      path: '/contacts',
      handler: contacts_handler,
    },
    {
      method: 'GET',
      path: '/media/{media_id}',
      handler: media_handler,
    },
    {
      method: 'GET',
      path: '/chats/{chat_id}',
      handler: (request, h) => chat_handler(request, h, false),
    },
    {
      method: 'GET',
      path: '/chats/{chat_id}/allunreadmessages',
      handler: (request, h) => chat_handler(request, h, true),
    },
    {
      method: 'GET',
      path: '/chats/{chat_id}/info',
      handler: chat_info_handler,
    },
    {
      method: 'GET',
      path: '/',
      handler: new_chat_or_pair_handler,
    },
  ]);

  return server;
};

export const start = async function (): Promise<void> {
  await server.start();
  console.log(`Listening on ${server.settings.host}:${server.settings.port}`);
};

let fatalProcessHandlersInstalled = false;

function installFatalProcessHandlers(): void {
  if (fatalProcessHandlersInstalled) return;

  fatalProcessHandlersInstalled = true;
  process.on('unhandledRejection', err => {
    markClientDead('unhandled rejection', err);
  });

  process.on('uncaughtException', err => {
    markClientDead('uncaught exception', err);
  });
}

/** Start HTTP before WhatsApp initialization so pairing/re-auth remains available. */
export async function runApplication(): Promise<void> {
  installFatalProcessHandlers();

  try {
    await init();

    // The HTTP server must be available while WhatsApp is authenticating.
    // In particular, the pairing page needs to serve the QR code emitted
    // by client.initialize(), which may remain pending until it is scanned.
    await start();
    await client.initialize();
  } catch (err) {
    markClientDead('application startup failed', err);
  }
}

// Importing this module exposes init() without starting the CLI or WhatsApp.
if (require.main === module) {
  // If `init` is passed, create a user; otherwise start the client and server.
  if (process.argv.length > 2 && process.argv[2] === 'init') {
    ensureRuntimeDirectories();

    if (fs.existsSync(USER_CONFIG_PATH)) {
      console.error(
        `Refusing to overwrite existing login: ${USER_CONFIG_PATH}`
      );
      process.exitCode = 1;
    } else {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      rl.question('Enter the phone number: ', phoneNumberInput => {
        const phoneNumber = phoneNumberInput.trim();

        if (!phoneNumber) {
          console.error('The phone number cannot be empty.');
          rl.close();
          process.exitCode = 1;
          return;
        }

        // readline does not publicly type its password-masking internals.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rli = rl as any;

        rli.stdoutMuted = true;
        rli.query = 'Enter the password: ';

        rl.question(rli.query, async passwordInput => {
          try {
            const password = passwordInput.trim();

            if (!password) {
              console.error('\nThe password cannot be empty.');
              process.exitCode = 1;
              return;
            }

            const hash = await argon2.hash(password);
            const cookieKey = randomBytes(32).toString('base64');
            const user = {phoneNumber, hash, cookieKey};

            fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(user), {
              encoding: 'utf8',
              flag: 'wx',
              mode: 0o600,
            });
            fs.chmodSync(USER_CONFIG_PATH, 0o600);
            console.log('\nUser created');
          } catch (err) {
            console.error('\nUnable to create the user configuration.');
            console.error(errorDetails(err));
            process.exitCode = 1;
          } finally {
            rl.close();
          }
        });

        rli._writeToOutput = function _writeToOutput(stringToWrite: string) {
          if (rli.stdoutMuted) rli.output.write('*');
          else rli.output.write(stringToWrite);
        };
      });
    }
  } else {
    void runApplication();
  }
}

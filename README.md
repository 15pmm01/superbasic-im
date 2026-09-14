# SuperBasic IM

SuperBasic IM is a self-hosted web interface for WhatsApp that remains usable
on basic phones and old browsers. It connects to WhatsApp through
[`whatsapp-web.js`](https://github.com/pedroslopez/whatsapp-web.js) and serves
both regular HTML and compact WML.

This repository is a maintained revival of
[`tomtau/superbasic-im`](https://github.com/tomtau/superbasic-im). It includes
major compatibility, reliability, installation, and WML work beyond the
original project.

**New to Linux?** Follow the complete
[Ubuntu VPS installation guide](docs/ubuntu-install.md). It covers SSH, the
application's system packages, Node.js, npm, Chrome's native libraries, PM2,
secure publishing requirements, and WhatsApp pairing without taking over the
host's existing proxy, firewall, DNS, or certificates.

> [!WARNING]
> This is an unofficial client. It is not affiliated with or endorsed by
> WhatsApp or Meta. WhatsApp Web can change without notice, and using an
> unofficial client may carry account risk.

## Features

- Send and receive text messages and files.
- Browse recent chats, all chats, contacts, and chat information.
- Download contact VCards.
- Convert emoji to textual representations for older browsers.
- Serve complete English and German HTML and WML interfaces.
- Paginate and sanitize WML output for constrained devices.
- Recover automatically from several common Puppeteer and WhatsApp Web
  failures when used with a process manager.
- Keep authentication, media, cache, and login configuration outside the
  generated `dist/` directory.

Audio and video calls, instant push notifications, locations, polls, and group
administration are not supported.

## Requirements

- Linux is the tested deployment platform.
- Node.js 24 LTS and npm. The included `.nvmrc` selects the tested major
  version when using [nvm](https://github.com/nvm-sh/nvm).
- Git.
- Enough memory and disk space for Chromium. PM2 is configured to restart the
  application if it exceeds 350 MB of memory.
- The operating-system libraries required by Chrome. See the
  [beginner installation guide](docs/ubuntu-install.md) for the complete
  Ubuntu package command.

## Quick start

This short path assumes that Git, nvm, Node.js, Chrome's Linux libraries, and
an HTTPS reverse proxy are already available. For a new server or a machine
whose existing services must be preserved, use the guide's
[experienced-operator quick start](docs/ubuntu-install.md#quick-start-for-experienced-operators)
or its complete step-by-step instructions.

Clone the maintained fork and select its Node.js version:

```sh
git clone https://github.com/15pmm01/superbasic-im.git
cd superbasic-im
nvm install
nvm use
```

Install the exact dependency versions recorded in `package-lock.json`, test
the source, and build `dist/`:

```sh
npm ci
npm test
npm run build
npm run check:browser
```

The last command launches Puppeteer's downloaded Chrome for Testing and fails
with a focused diagnostic if required operating-system libraries are missing.

Create the web login. The requested phone number is also the username you will
enter on the login page; it must be entered there exactly as configured. Setup
refuses to overwrite an existing `data/user.json` file.

```sh
npm run setup
```

For a local-only foreground test:

```sh
HOST=127.0.0.1 npm start
```

From another terminal on the VPS, check
`http://127.0.0.1:4000/login`. After configuring your own HTTPS reverse proxy,
sign in through its public HTML hostname and refresh the main page until the
WhatsApp QR code appears. In WhatsApp on a supported phone, open **Linked
devices**, add a device, and scan the QR code. Initial pairing must be
completed through the HTML interface; a WML phone cannot scan the QR code
displayed by the server.

Stop the foreground process with `Ctrl+C` after testing.

## Running with PM2

Use PM2 under the same Node.js version and start the supplied ecosystem file.
The conditional command preserves an existing installation:

```sh
nvm use
command -v pm2 >/dev/null 2>&1 || npm install --global pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

Run the command printed by `pm2 startup` to enable startup after reboot, then
run `pm2 save` once more. Useful commands are:

```sh
pm2 status
pm2 logs superbasic-im
pm2 restart superbasic-im
pm2 stop superbasic-im
```

The PM2 configuration listens on `127.0.0.1:4000`, uses secure production
cookies, and restarts the process if the browser cannot initialize. Put an
HTTPS reverse proxy in front of it rather than exposing the Node.js port
directly. The project deliberately does not install or alter a reverse proxy,
firewall, DNS, or TLS certificates. The
[beginner installation guide](docs/ubuntu-install.md) explains the required
proxy behavior and includes an optional, maintainer-tested Apache reference.

## Reverse proxy and WML

Any HTTPS-capable reverse proxy may be used. The proxy must preserve `Host`,
forward to `127.0.0.1:4000`, and keep port 4000 private. This minimal Apache
example is included because Apache is the maintainer-tested deployment. It is
not installed or configured automatically; place these directives inside your
own HTTPS virtual host with `proxy`, `proxy_http`, and `headers` available.

```apache
# Inside the existing HTTPS virtual host for im.example.com:
ProxyRequests Off
ProxyPreserveHost On
RequestHeader unset X-SuperBasic-Format
ProxyPass "/" "http://127.0.0.1:4000/"
ProxyPassReverse "/" "http://127.0.0.1:4000/"
```

For a WML-only virtual host, use the same configuration and add:

```apache
RequestHeader unset X-SuperBasic-Format
RequestHeader set X-SuperBasic-Format "wml"
```

SuperBasic IM intentionally relies on this header instead of guessing from the
user agent.

If you find yourself unable to log into the WML site, it is likely a cookie-related problem.
You can try using the special WAP gateway services that I operate on [15pmm01.com/wap](https://15pmm01.com/wap/).
Both of the HTML to WML converting gateways — WAP Lite Gateway and WAP Extra Lite Gateway — are specifically designed
to handle cookies and HTTPS for very old phones that are unable to on their own.

## Language selection

Both HTML and WML are available in English and German. By default, each request
uses the client's `Accept-Language` header, with English as the fallback. To
force one language for the entire installation, set `SUPERBASIC_LANGUAGE` to
`en` or `de` before starting the process.

The WML pairing notice cannot display the QR code itself. Set
`SUPERBASIC_HTML_HOST` if that notice should tell users where to open the HTML
interface:

```sh
SUPERBASIC_LANGUAGE=de SUPERBASIC_HTML_HOST=im.example.com pm2 start ecosystem.config.js --update-env
pm2 save
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Address used by `npm start`; the supplied PM2 file overrides it with `127.0.0.1`. |
| `PORT` | `4000` | HTTP listening port. |
| `SUPERBASIC_DATA_DIR` | `<repository>/data` | Absolute or relative location for persistent runtime data. Relative custom paths resolve from the process working directory. |
| `SUPERBASIC_LANGUAGE` | automatic | `en` or `de` forces a language; any other value uses `Accept-Language` and falls back to English. |
| `SUPERBASIC_HTML_HOST` | unset | Optional hostname displayed when a WML user must complete pairing through HTML. |
| `NODE_ENV` | unset | When set to `production`, the login session cookie is marked Secure. Use this only when every client reaches the service through HTTPS. |

## Persistent data and backups

Runtime state is stored beneath `data/` by default:

| Path | Contents | Backup? |
| --- | --- | --- |
| `data/user.json` | Password hash, login username, and cookie-signing key | Yes |
| `data/.wwebjs_auth/` | WhatsApp linked-device session | Yes |
| `data/media/` | Downloaded message media and lookup links | Optional |
| `data/.wwebjs_cache/` | Re-creatable WhatsApp Web cache | No |

Never commit this directory. Protect backups because `user.json` and
`.wwebjs_auth/` contain authentication material. Stop the process before
copying `.wwebjs_auth/` so the backup is internally consistent.

The application creates `data/` and `data/media/` with mode `700` and
`data/user.json` with mode `600`. Startup also hardens these paths if they were
created by an older release with broader permissions.

Older installations stored these items inside `dist/`. Stop the old process
and copy `user.json`, `media/`, `.wwebjs_auth/`, and `.wwebjs_cache/` into the
new `data/` directory before starting this version. Do not run two instances
against the same WhatsApp session directory.

## Updating

To install a new release while preserving the tested WhatsApp dependency:

```sh
git pull --ff-only
nvm install
nvm use
npm ci
npm test
npm run build
pm2 restart superbasic-im
```

### Refreshing WhatsApp Web support

The repository tracks the `main` branch of `whatsapp-web.js`, while
`package-lock.json` records the exact commit tested with each revision. A clean
`npm ci` therefore remains reproducible.

If WhatsApp suddenly stops working, opt into the newest upstream commit with:

```sh
npm run update:whatsapp
npm test
npm run build
pm2 restart superbasic-im
```

The update command preserves the moving `#main` declaration in `package.json`
but rewrites `package-lock.json` to the newly resolved exact HTTPS commit. Test
before keeping the change. To roll back an unsuccessful local refresh:

```sh
git restore package.json package-lock.json
npm ci
npm run build
pm2 restart superbasic-im
```

## Security notes

- Keep port 4000 private and expose the service through your chosen reverse
  proxy. Configure the host's firewall according to its existing policy.
- Use HTTPS. The supplied production configuration requires it for secure
  login cookies.
- Treat `data/` as secret and never publish it in an issue or backup archive.
- `npm audit --omit=dev` currently reports an unfixed `extract-zip` advisory
  inherited through Puppeteer's browser-download tooling. Install only from
  the recorded lockfile and trusted upstream sources; do not apply blind
  dependency overrides merely to silence the report.

## Development

```sh
nvm use
npm ci
npm test
```

Generated JavaScript belongs in `dist/` and is not committed. Make source
changes in `src/`, then run `npm run build`. Language-specific templates live
in `views/en/`, `views/de/`, `views/wml/en/`, and `views/wml/de/`. See
[CONTRIBUTING.md](CONTRIBUTING.md) before opening an issue or pull request.

## AI assistance disclosure

This maintained revival was developed with substantial assistance from
OpenAI's ChatGPT and Codex, including work on code, tests, documentation, and
deployment guidance. The maintainer directed the work, reviewed the changes,
and performed automated and real-server testing. The maintainer remains
responsible for the published project.

## License and credits

SuperBasic IM is distributed under the [Mozilla Public License 2.0](LICENSE).
The original project and copyright remain credited to its original author and
contributors. This maintained fork adds later revival and WML work while
preserving that history.

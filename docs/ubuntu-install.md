# Beginner installation guide: Ubuntu VPS

This guide supports both a newly created Ubuntu server and an established
machine that already hosts other services. It installs and tests SuperBasic IM
without taking ownership of the server's public-facing infrastructure. Follow
the application sections in order and do not skip the browser check.

The commands below were tested on **64-bit Intel/AMD Ubuntu 22.04 LTS**. Linux
ARM servers are not supported because Puppeteer's downloaded Chrome for Testing
does not currently provide a Linux ARM64 binary.

> [!WARNING]
> SuperBasic IM is an unofficial WhatsApp client. It is not affiliated with or
> endorsed by WhatsApp or Meta. WhatsApp Web can change without notice, and an
> unofficial client may carry account risk.

> [!CAUTION]
> On an established server, inspect existing packages, ports, and PM2 processes
> before changing them. The application setup below never removes packages or
> replaces an existing configuration file. DNS, reverse proxies, firewalls,
> and TLS certificates are deliberately left to the server operator.

## Quick start for experienced operators

Use this path when the server already has Git, nvm, Node.js, Chrome's Linux
libraries, and an operator-managed HTTPS reverse proxy. It installs only the
application and PM2. Replace `im.example.com` with the HTML hostname before
starting it:

```sh
git clone https://github.com/15pmm01/superbasic-im.git && cd superbasic-im
nvm install && nvm use
npm ci
npm test && npm run build && npm run check:browser
npm run setup
command -v pm2 >/dev/null 2>&1 || npm install --global pm2
SUPERBASIC_HTML_HOST=im.example.com pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

Run the exact `sudo env PATH=...` command printed by `pm2 startup`, then run
`pm2 save` once more. Configure the existing HTTPS reverse proxy to forward to
`127.0.0.1:4000`, following the required
[proxy boundaries](#7-publish-the-local-service-securely), and then
[link WhatsApp](#8-log-in-and-link-whatsapp).

If `npm run check:browser` fails, stop and install the missing system
libraries from step 1. If any prerequisite is unfamiliar or this VPS hosts
other services, use the complete guide below instead.

## What you need before starting

- An x86-64/amd64 VPS running Ubuntu 22.04 LTS.
- At least 2 GB RAM, preferably with swap, and about 10 GB free disk space.
- The VPS public IPv4 address.
- A normal, non-root user that can run `sudo`.
- A current backup if the VPS already hosts anything important.
- A domain you control. This guide uses two example names:
  - `im.example.com` for the normal HTML site.
  - `wapim.example.com` for the WML site.
- A computer or smartphone with the official WhatsApp app for the initial QR
  scan.

Replace every occurrence of `im.example.com` and `wapim.example.com` below with
your real hostnames. Do not literally use `example.com`.

## A few terminal basics

You connect to the VPS using SSH. Your VPS provider shows its IP address,
username, and initial password or SSH-key instructions. From Terminal on macOS
or Linux, Windows Terminal on modern Windows, or your provider's web console,
the connection normally looks like this:

```sh
ssh YOUR_USERNAME@YOUR_SERVER_IP
```

- Enter one command at a time and press **Enter**.
- Do not type the `$` or `#` symbols shown in some Linux tutorials.
- Linux passwords do not display dots or stars while you type. That is normal.
- `sudo` runs one command with administrator rights and may ask for your Linux
  account password.
- `Ctrl+C` stops a foreground command that keeps running.
- If a command fails, stop and fix that error instead of continuing blindly.

Check that you are not logged in as root and that `sudo` works:

```sh
whoami
sudo -v
```

`whoami` should print your normal username, not `root`.

### If your provider only gave you root

While logged in as root, create a normal administrator named `superbasic`:

```sh
adduser superbasic
usermod -aG sudo superbasic
```

Choose a strong Linux account password when asked. If root login uses an SSH
key, copy only the authorized-key list to the new account:

```sh
install -d -m 700 -o superbasic -g superbasic /home/superbasic/.ssh
if [ -f /root/.ssh/authorized_keys ]; then install -m 600 -o superbasic -g superbasic /root/.ssh/authorized_keys /home/superbasic/.ssh/authorized_keys; fi
```

Keep the root session open temporarily. Open a second terminal, reconnect as
the new user, and verify `sudo -v` succeeds before closing the root session:

```sh
ssh superbasic@YOUR_SERVER_IP
sudo -v
```

## 1. Update Ubuntu and install system packages

First confirm the Ubuntu version and CPU architecture:

```sh
cat /etc/os-release
dpkg --print-architecture
```

The architecture must be `amd64`. Refresh Ubuntu's package information and
review pending upgrades:

```sh
sudo apt-get update
apt list --upgradable
```

On a new VPS, apply the pending upgrades before continuing:

```sh
sudo apt-get upgrade
```

On an established server, use its normal maintenance procedure instead of
blindly upgrading every package. Applying upgrades is strongly recommended,
but it is not a SuperBasic IM installation requirement.

The following block contains Git, download tools, and the Debian/Ubuntu runtime
dependencies listed by Puppeteer for Chrome, plus libraries the clean-VPS test
found through `ldd`. It requests only packages that are currently missing. This
preserves the manual/automatic APT state of packages already on an established
server. `--no-install-recommends` also avoids unrelated desktop applications
that Ubuntu may otherwise pull onto a headless VPS.

```bash
required_packages=(
    git
    curl
    ca-certificates
    wget
    xdg-utils
    fonts-liberation
    libasound2
    libatk-bridge2.0-0
    libatk1.0-0
    libatspi2.0-0
    libc6
    libcairo2
    libcups2
    libdbus-1-3
    libexpat1
    libfontconfig1
    libgbm1
    libgcc-s1
    libglib2.0-0
    libgtk-3-0
    libnspr4
    libnss3
    libpango-1.0-0
    libpangocairo-1.0-0
    libstdc++6
    libx11-6
    libx11-xcb1
    libxcb1
    libxcomposite1
    libxcursor1
    libxdamage1
    libxext6
    libxfixes3
    libxi6
    libxkbcommon0
    libxrandr2
    libxrender1
    libxss1
    libxtst6
    lsb-release
)

missing_packages=()

for package in "${required_packages[@]}"
do
    if ! dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q '^install ok installed$'
    then
        missing_packages+=("$package")
    fi
done

if [ "${#missing_packages[@]}" -gt 0 ]
then
    printf 'Installing missing packages:\n'
    printf '  %s\n' "${missing_packages[@]}"
    sudo apt-get install -y --no-install-recommends "${missing_packages[@]}"
else
    printf 'All required system packages are already installed.\n'
fi
```

You do **not** need to install a separate `chromium` or `google-chrome`
package. `npm ci` will download the Chrome for Testing build matched to the
project's exact Puppeteer version. The packages above provide the Linux
libraries that browser needs.

If Ubuntu says a reboot is required, reboot and reconnect:

```sh
test -f /var/run/reboot-required && sudo reboot
```

If that command closes the SSH connection, wait about a minute and run your
original `ssh` command again.

## 2. Install nvm, Node.js, and npm

[nvm](https://github.com/nvm-sh/nvm) installs Node.js for your normal user.
Node.js includes npm, so do not separately run `sudo apt install nodejs npm`.
First load an existing nvm installation if one is present:

```bash
export NVM_DIR="$HOME/.nvm"

if [ -s "$NVM_DIR/nvm.sh" ]
then
    . "$NVM_DIR/nvm.sh"
fi
```

If `nvm --version` now works, keep that installation and continue to step 3.
Do not replace or remove it. If nvm is still missing, make sure the target path
does not contain another or incomplete installation:

```bash
if command -v nvm >/dev/null 2>&1
then
    nvm --version
elif [ -e "$NVM_DIR" ]
then
    printf 'STOP: %s already exists but nvm could not be loaded.\n' "$NVM_DIR"
    printf 'Inspect that installation instead of overwriting it.\n'
    false
else
    printf 'nvm is not installed; continue with the installer below.\n'
fi
```

Only when the final line says nvm is not installed, download the pinned nvm
0.40.7 installer, verify its SHA-256 checksum, and run it:

```sh
nvm_installer="$(mktemp /tmp/nvm-install.XXXXXX)"
curl -fsSL 'https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.7/install.sh' -o "$nvm_installer"
printf '%s  %s\n' '066ce4eaf4d78eaa6410433bc9ba58faaba646157cbbed6109153e6c24c5f8a5' "$nvm_installer" | sha256sum -c -
bash "$nvm_installer"
rm -- "$nvm_installer"
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
nvm --version
```

If a later SSH session says `nvm: command not found`, run `source ~/.bashrc`
or reconnect. The installer adds nvm setup to the current user's shell profile.

## 3. Download SuperBasic IM

Clone the maintained repository and enter its directory:

```sh
cd "$HOME"
git clone https://github.com/15pmm01/superbasic-im.git
cd "$HOME/superbasic-im"
```

The repository's `.nvmrc` selects the tested Node.js major version. Install and
activate it:

```sh
nvm install
nvm use
node --version
npm --version
```

## 4. Install, test, and build the application

Install exactly the dependency versions in `package-lock.json`:

```sh
npm ci
```

Warnings about deprecated transitive packages or known advisories may appear.
Do not run `npm audit fix --force`; forced replacements can break the tested
WhatsApp and browser dependency chain. See the repository README's security
notes for the currently reviewed advisory status.

Compile, lint, and run the automated application tests:

```sh
npm test
```

Build the generated JavaScript in `dist/`:

```sh
npm run build
```

Now perform the check that catches the missing-library problem a bare VPS can
otherwise hide until first launch:

```sh
npm run check:browser
```

The final line must be:

```text
browser-runtime-check=PASS
```

If it is not, see [Chrome fails to start](#chrome-fails-to-start) below. Do not
continue to PM2 until this check passes.

## 5. Create the private web login

Run the one-time setup command:

```sh
npm run setup
```

It asks for a phone number and password. The phone-number value is the username
for this private website; enter the exact same value on its login page later.
Use a unique, strong password. Password characters appear as stars while you
type.

Setup writes only beneath `~/superbasic-im/data/`. The application refuses to
overwrite an existing login. Confirm the private permissions:

```sh
stat -c 'mode=%a owner=%U:%G path=%n' data data/media data/user.json
```

The expected modes are `700` for both directories and `600` for `user.json`.
Never post or commit anything from `data/`; it contains login and WhatsApp
session secrets.

## 6. Install PM2 and start the application

PM2 keeps the Node.js process running, restarts it after a crash, and can start
it again after a reboot. Keep an existing PM2 installation under the selected
Node version; install it only when the command is missing:

```bash
nvm use

if command -v pm2 >/dev/null 2>&1
then
    printf 'Using existing PM2: '
else
    npm install --global pm2
fi

pm2 --version
```

Inspect existing PM2 applications and make sure port 4000 is free:

```sh
pm2 status
sudo ss -ltnp 'sport = :4000'
```

If either output shows an existing application named `superbasic-im` or
another process listening on port 4000, stop. Do not delete or replace it until
you understand what it is. Otherwise, start SuperBasic IM after replacing the
hostname:

```sh
SUPERBASIC_HTML_HOST=im.example.com pm2 start ecosystem.config.js
```

The supplied PM2 file binds the application to `127.0.0.1:4000`, enables
production-only secure cookies, and restarts a failed browser process. It does
not expose port 4000 directly to the Internet.

Check the process and its most recent log lines:

```sh
pm2 status
pm2 logs superbasic-im --nostream --lines 100
```

The process should be `online`. PM2 can report that before Chrome and WhatsApp
finish initializing, so wait until the log contains a new
`Listening on 127.0.0.1:4000` line. Then confirm the local HTTP server responds:

```sh
curl -I http://127.0.0.1:4000/login
```

Save the process list and create the reboot service. Existing PM2 applications
shown above remain part of the saved process list; this does not delete them:

```sh
pm2 save
pm2 startup
```

`pm2 startup` prints a long command beginning with `sudo env PATH=...`. Copy
that exact command from its output and run it. Then save once more:

```sh
pm2 save
```

This exact-output step matters when Node was installed with nvm. Do not invent
your own path or run the first `pm2 startup` command with `sudo`.

## 7. Publish the local service securely

At this point SuperBasic IM is running only on `127.0.0.1:4000`. That is the
intended application boundary. The project does not install or reconfigure a
reverse proxy, edit DNS, change firewall rules, or obtain TLS certificates.
Those are host-level decisions, and changing them automatically could disrupt
an established server.

To make the service public, use the reverse proxy and certificate workflow you
already trust. Apache, Caddy, Nginx, a hosting control panel, and a managed
proxy are all valid choices. Configure it to:

- terminate HTTPS and proxy to `http://127.0.0.1:4000`;
- preserve the original `Host` header;
- keep port 4000 private and unreachable from the Internet;
- avoid caching this private, stateful interface;
- optionally add `X-Robots-Tag: noindex, nofollow, noarchive`;
- remove any visitor-supplied `X-SuperBasic-Format` header; and
- on the WML hostname only, set `X-SuperBasic-Format: wml` after removing it.

HTTPS is required with the supplied PM2 configuration because production login
cookies are marked `Secure`. Do not publish a login over plain HTTP. Configure
your own firewall or provider security rules for the public services you have
chosen, taking care to preserve SSH and every existing service. Never open TCP
port 4000 publicly.

The relevant official documentation is:

- [Apache reverse proxy guide](https://httpd.apache.org/docs/2.4/howto/reverse_proxy.html)
- [Caddy reverse proxy quick-start](https://caddyserver.com/docs/quick-starts/reverse-proxy)
- [Nginx proxy module](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)
- [Certbot](https://certbot.eff.org/) if it fits your existing TLS setup

Your proxy or hosting provider may manage HTTPS automatically. Follow its
documentation rather than adding a second certificate manager.

### DNS

At the company that manages your domain's DNS, create these records:

| Type | Name | Value |
| --- | --- | --- |
| `A` | `im` | Your VPS public IPv4 address |
| `A` | `wapim` | Your VPS public IPv4 address |

DNS interfaces differ, so the Name may instead require the complete hostname.
If you add an `AAAA` record, it must point to IPv6 configured on this VPS;
otherwise omit it.

Wait for DNS to update, then verify both names resolve to the VPS:

```sh
getent ahostsv4 im.example.com
getent ahostsv4 wapim.example.com
```

Both commands must show your VPS IPv4 address before publishing the service.

### Optional, maintainer-tested Apache reference

The maintainer uses Apache, so these proxy directives are tested. They are a
reference for operators who have already chosen Apache; SuperBasic IM does not
install Apache, enable modules or sites, reload the service, or manage its
certificates.

The HTML HTTPS virtual host needs `mod_proxy`, `mod_proxy_http`, and
`mod_headers`, plus whatever TLS configuration your server already uses:

```apache
# Inside the existing HTTPS virtual host for im.example.com:
Header always set X-Robots-Tag "noindex, nofollow, noarchive, nosnippet, noimageindex"
<IfModule mod_cache.c>
    CacheDisable /
</IfModule>

ProxyRequests Off
ProxyPreserveHost On
RequestHeader unset X-SuperBasic-Format
ProxyPass "/" "http://127.0.0.1:4000/" connectiontimeout=5 timeout=300
ProxyPassReverse "/" "http://127.0.0.1:4000/"
LimitRequestBody 6291456
```

Use the same directives inside the HTTPS virtual host for
`wapim.example.com`, then add the trusted WML selection after the `unset`:

```apache
RequestHeader unset X-SuperBasic-Format
RequestHeader set X-SuperBasic-Format "wml"
```

Removing the incoming header prevents a visitor from selecting a format on an
unintended host. `ProxyRequests Off` ensures this is a reverse proxy, not a
public forward proxy. Adapt filenames, virtual hosts, logging, redirects, and
TLS to the existing Apache installation. Check the complete Apache
configuration before reloading it.

After your chosen proxy and HTTPS setup is complete, verify the public result:

```sh
curl -I https://im.example.com/login
curl -I https://wapim.example.com/login
```

The first response should be `text/html`; the second should be
`text/vnd.wap.wml`. Both must use HTTPS.

Very old phones may not trust a modern certificate chain. That is a device
trust-store limitation, not an application error. Test the real target phone
before relying on this deployment; some devices may require a different
certificate authority or a compatible WAP proxy.

## 8. Log in and link WhatsApp

Open the **HTML** address on a modern browser first:

```text
https://im.example.com/login
```

1. Enter the website username and password created by `npm run setup`.
2. Wait for the WhatsApp QR code. Refresh once if the page appeared before the
   QR code was ready.
3. On the smartphone running WhatsApp, open **Linked devices** and choose
   **Link a device**.
4. Scan the QR code shown by SuperBasic IM.
5. Wait for WhatsApp to finish synchronizing, then refresh the page.
6. Test sending and receiving a message.
7. Open `https://wapim.example.com/login` on the target phone to test WML.

Initial pairing must use the HTML site because WML cannot display the pairing
QR code in a useful way.

## Everyday commands

Run these from `~/superbasic-im` after `nvm use`:

```sh
pm2 status
pm2 logs superbasic-im --nostream --lines 100
pm2 restart superbasic-im
pm2 stop superbasic-im
pm2 start superbasic-im
```

To follow live logs, run `pm2 logs superbasic-im`; press `Ctrl+C` to leave the
log viewer without stopping the application.

## Updating SuperBasic IM

Back up `data/` before an important update. It contains secrets, so store the
backup privately. Then run:

```sh
cd "$HOME/superbasic-im"
nvm install
nvm use
git pull --ff-only
npm ci
npm test
npm run build
npm run check:browser
pm2 restart superbasic-im
pm2 save
```

If `.nvmrc` moves to a newer Node major version, reinstall PM2 under that Node
version and regenerate its startup service as described in the official
[PM2 startup documentation](https://pm2.keymetrics.io/docs/usage/startup/).

## Troubleshooting

### `nvm: command not found`

Reload the shell setup:

```sh
source "$HOME/.bashrc"
```

If that does not work:

```sh
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
```

### Chrome fails to start

Run the preflight again:

```sh
cd "$HOME/superbasic-im"
nvm use
npm run check:browser
```

If it lists missing `.so` libraries, repeat the `apt-get install` command from
step 1. For a low-level check:

```sh
browser="$(node -e 'process.stdout.write(require("puppeteer").executablePath())')"
ldd "$browser" | sed -n '/not found/p'
```

No output from `ldd` means no linked library is missing. Puppeteer's official
[Linux troubleshooting guide](https://pptr.dev/troubleshooting) contains the
upstream dependency list and additional sandbox diagnostics.

### Port 4000 is already occupied

```sh
sudo ss -ltnp 'sport = :4000'
pm2 status
```

Do not start a second copy. Stop the unexpected process or use the already
running PM2 application.

### PM2 says `errored` or keeps restarting

```sh
pm2 logs superbasic-im --nostream --lines 200
npm run check:browser
```

The application deliberately exits when Chrome cannot initialize so PM2 does
not leave a web server online with a dead WhatsApp backend. The log contains
the actual startup error.

### The reverse proxy shows `502` or `503`

```sh
pm2 status
curl -I http://127.0.0.1:4000/login
```

A failed local `curl` means the application is not listening; inspect the PM2
logs and wait for the newest `Listening on 127.0.0.1:4000` line. A successful
local `curl` plus a public proxy error points to the chosen reverse proxy or
its timing. Use that product's configuration check, service status, and logs.
Immediately after an application restart, a brief `503` can occur before the
backend begins listening.

### Login immediately returns to the login page

Production cookies are marked Secure. Use the `https://` address, not the VPS
IP address or plain `http://` URL. Also enter the username exactly as it was
entered during setup.

## Primary upstream references

- [Original SuperBasic IM article](https://www.tomtau.be/blog/04-whatsapp-on-dumbphones/)
- [nvm installation instructions](https://github.com/nvm-sh/nvm#installing-and-updating)
- [Puppeteer troubleshooting](https://pptr.dev/troubleshooting)
- [PM2 startup scripts](https://pm2.keymetrics.io/docs/usage/startup/)
- [Apache reverse-proxy guide](https://httpd.apache.org/docs/2.4/howto/reverse_proxy.html)
- [Apache request-header module](https://httpd.apache.org/docs/2.4/mod/mod_headers.html)
- [Caddy reverse-proxy quick-start](https://caddyserver.com/docs/quick-starts/reverse-proxy)
- [Nginx proxy module](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)
- [Certbot](https://certbot.eff.org/)

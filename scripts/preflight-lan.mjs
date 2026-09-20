/**
 * Preflight checks for `npm run dev:lan`.
 *
 * Catches the three things that otherwise fail confusingly:
 *
 *  1. Certificates missing         -> Vite throws a stack trace
 *  2. Port already in use          -> with strictPort, Vite exits while the API
 *                                     keeps running. If the squatter is an old
 *                                     HTTP dev server, the browser then reports
 *                                     SSL_ERROR_RX_RECORD_TOO_LONG, which gives
 *                                     no hint about the real cause.
 *  3. LAN IP changed since `npm run cert` -> the certificate no longer matches
 *                                     the address, so every device rejects it.
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lanAddresses } from './generate-dev-cert.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY = path.join(ROOT, 'certs/dev-key.pem');
const CERT = path.join(ROOT, 'certs/dev-cert.pem');

const WEB_PORT = Number(process.env.PORT || 8443);
const API_PORT = Number(process.env.API_PORT || 4000);

const red = (text) => `\x1b[31m${text}\x1b[0m`;
const yellow = (text) => `\x1b[33m${text}\x1b[0m`;

function fail(title, lines) {
  console.error(`\n${red('✗ ' + title)}\n`);
  for (const line of lines) console.error(`  ${line}`);
  console.error('');
  process.exit(1);
}

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.createServer();
    socket.once('error', (error) => resolve(error.code === 'EADDRINUSE'));
    socket.once('listening', () => socket.close(() => resolve(false)));
    socket.listen(port, '0.0.0.0');
  });
}

/** Best-effort description of whatever is holding a port. */
function describeHolder(port) {
  try {
    const output = execFileSync('ss', ['-ltnp'], { encoding: 'utf8' });
    const line = output.split('\n').find((row) => row.includes(`:${port} `));
    const pid = line?.match(/pid=(\d+)/)?.[1];
    return pid ? `PID ${pid}` : 'another process';
  } catch {
    return 'another process';
  }
}

async function main() {
  // 1. Certificates present?
  if (!fs.existsSync(KEY) || !fs.existsSync(CERT)) {
    fail('No development certificate found.', ['Run this first:', '', '  npm run cert']);
  }

  // 2. Ports free?
  for (const [port, label] of [
    [WEB_PORT, 'web server'],
    [API_PORT, 'API'],
  ]) {
    if (await portInUse(port)) {
      fail(`Port ${port} is already in use (${label}).`, [
        `Something is already listening on ${port} — ${describeHolder(port)}.`,
        'Most likely an earlier dev server that is still running.',
        '',
        'If it is an old HTTP dev server, your browser will report',
        yellow('  SSL_ERROR_RX_RECORD_TOO_LONG'),
        'because it speaks HTTPS to a server answering in plain HTTP.',
        '',
        'Stop it, then retry:',
        '',
        `  kill $(ss -ltnp | grep ':${port} ' | grep -oP 'pid=\\K\\d+')`,
        '  npm run dev:lan',
      ]);
    }
  }

  // 3. Does the certificate still cover this machine's address?
  const addresses = lanAddresses();
  let covered = [];
  try {
    const text = execFileSync('openssl', ['x509', '-in', CERT, '-noout', '-ext', 'subjectAltName'], {
      encoding: 'utf8',
    });
    covered = [...text.matchAll(/IP Address:([\d.]+)/g)].map((match) => match[1]);
  } catch {
    // openssl missing is not fatal here; the cert itself already exists.
  }

  const uncovered = addresses.filter((address) => !covered.includes(address));
  if (covered.length && uncovered.length) {
    fail('Your LAN address changed since the certificate was generated.', [
      `Certificate covers: ${covered.join(', ') || '(none)'}`,
      `This machine is now: ${addresses.join(', ')}`,
      '',
      'Devices would reject the certificate. Regenerate it:',
      '',
      '  npm run cert',
    ]);
  }

  const primary = addresses[0];
  if (primary) {
    console.log(`\n  Serving over HTTPS. On any device on this WiFi:\n`);
    console.log(`    Website        https://${primary}:${WEB_PORT}/`);
    console.log(`    Admin console  https://${primary}:${WEB_PORT}/admin`);
    console.log(`    Doctor portal  https://${primary}:${WEB_PORT}/doctor`);
    console.log(`\n  Accept the certificate warning once per device.\n`);
  }
}

main();

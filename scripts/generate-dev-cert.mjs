/**
 * Generates a self-signed TLS certificate for LAN development.
 *
 *   node scripts/generate-dev-cert.mjs
 *
 * Why this is needed: browsers only expose getUserMedia (camera and
 * microphone) in a "secure context". localhost is exempt, but a LAN address
 * like https://192.168.1.14 is not — over plain HTTP the video call silently
 * fails at permission time. So to test from a phone or a second laptop on the
 * same WiFi, the dev server has to speak HTTPS.
 *
 * The certificate covers localhost plus every private IPv4 address on this
 * machine, so the same cert works however you reach the box. It is self-signed,
 * so each device has to accept a one-time browser warning.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CERT_DIR = path.join(ROOT, 'certs');
const KEY_PATH = path.join(CERT_DIR, 'dev-key.pem');
const CERT_PATH = path.join(CERT_DIR, 'dev-cert.pem');

/** Every non-internal IPv4 address, so the cert matches whichever one you use. */
export function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((iface) => iface && iface.family === 'IPv4' && !iface.internal)
    .map((iface) => iface.address);
}

function main() {
  const addresses = lanAddresses();

  fs.mkdirSync(CERT_DIR, { recursive: true });

  const sans = [
    'DNS:localhost',
    'DNS:*.localhost',
    'IP:127.0.0.1',
    'IP:::1',
    ...addresses.map((address) => `IP:${address}`),
  ].join(',');

  try {
    execFileSync(
      'openssl',
      [
        'req', '-x509',
        '-newkey', 'rsa:2048',
        '-nodes',
        '-keyout', KEY_PATH,
        '-out', CERT_PATH,
        // 825 days is the longest validity browsers still accept.
        '-days', '825',
        '-subj', '/CN=Surgeons Poly Clinic Dev',
        '-addext', `subjectAltName=${sans}`,
        '-addext', 'basicConstraints=critical,CA:FALSE',
        '-addext', 'keyUsage=critical,digitalSignature,keyEncipherment',
        '-addext', 'extendedKeyUsage=serverAuth',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
  } catch (error) {
    console.error('Certificate generation failed. Is openssl installed?');
    console.error(String(error.stderr || error.message));
    process.exit(1);
  }

  fs.chmodSync(KEY_PATH, 0o600);

  console.log('Development certificate written to certs/\n');
  console.log('Covers:');
  console.log('  https://localhost:8443');
  for (const address of addresses) console.log(`  https://${address}:8443`);
  console.log('\nNext:');
  console.log('  npm run dev:lan');
  console.log('\nOn each device, the first visit shows a warning because the');
  console.log('certificate is self-signed — accept it once and the camera will work.');
}

// Only run when invoked directly; vite.config imports lanAddresses from here.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

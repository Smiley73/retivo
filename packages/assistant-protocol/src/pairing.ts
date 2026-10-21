/**
 * Pairing-code rules and the challenge-response proofs. Both ends call these
 * same functions over `globalThis.crypto.subtle` (Node 24 and browsers), so an
 * encoding disagreement cannot surface later as "pairing fails". The code is
 * never sent in any frame; each proof is bound to one connection by both nonces.
 */
import { NONCE_BYTES, PAIRING_CODE_ALPHABET, PAIRING_CODE_LENGTH } from './constants.js';

const utf8 = new TextEncoder();
const HKDF_INFO = 'retivo-assistant-pairing-v1';
const TAB_TAG = 'retivo-assistant-tab-proof-v1';
const BRIDGE_TAG = 'retivo-assistant-bridge-proof-v1';

/**
 * Canonical form of typed code: upper case, `I`/`L` as `1`, `O` as `0`, hyphens
 * and spaces dropped. `null` when the length is wrong or a character is outside
 * the alphabet.
 */
export function normalizePairingCode(input: string): string | null {
  const code = input
    .toUpperCase()
    .replace(/[-\s]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
  if (code.length !== PAIRING_CODE_LENGTH) return null;
  for (const char of code) {
    if (!PAIRING_CODE_ALPHABET.includes(char)) return null;
  }
  return code;
}

/** Whether typed text is a pairing code once normalized. */
export function isWellFormedPairingCode(input: string): boolean {
  return normalizePairingCode(input) !== null;
}

/** Display form: a hyphen after the fifth character. Throws on a malformed code. */
export function formatPairingCode(input: string): string {
  const code = normalizePairingCode(input);
  if (code === null) throw new Error('Not a well-formed pairing code');
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/** A fresh random handshake nonce as lower-case hex. */
export function generateNonce(): string {
  return bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function nonceBytes(nonce: string): Uint8Array<ArrayBuffer> {
  if (!new RegExp(`^[0-9a-f]{${NONCE_BYTES * 2}}$`).test(nonce)) throw new Error('Malformed nonce');
  return Uint8Array.from(nonce.match(/../g) ?? [], (pair) => parseInt(pair, 16));
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

interface ProofInputs {
  /** Typed or displayed code; normalized here. */
  code: string;
  /** Hex nonce from the bridge's `hello`. */
  bridgeNonce: string;
  /** Hex nonce from the tab's `pair`. */
  tabNonce: string;
}

/** HKDF-SHA256 over the code with both nonces as salt, then HMAC-SHA256 over a direction tag and the nonces. */
async function computeProof(tag: string, nonceOrder: 'tab-first' | 'bridge-first', inputs: ProofInputs): Promise<string> {
  const code = normalizePairingCode(inputs.code);
  if (code === null) throw new Error('Not a well-formed pairing code');
  const bridgeNonce = nonceBytes(inputs.bridgeNonce);
  const tabNonce = nonceBytes(inputs.tabNonce);
  const { subtle } = globalThis.crypto;
  const ikm = await subtle.importKey('raw', utf8.encode(code), 'HKDF', false, ['deriveKey']);
  const key = await subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: concat(bridgeNonce, tabNonce), info: utf8.encode(HKDF_INFO) },
    ikm,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign'],
  );
  const nonces = nonceOrder === 'tab-first' ? concat(tabNonce, bridgeNonce) : concat(bridgeNonce, tabNonce);
  return bytesToHex(new Uint8Array(await subtle.sign('HMAC', key, concat(utf8.encode(tag), nonces))));
}

/** The proof the tab sends in `pair`; hex. */
export function computeTabProof(inputs: ProofInputs): Promise<string> {
  return computeProof(TAB_TAG, 'tab-first', inputs);
}

/** The proof the bridge sends in `paired`; hex. */
export function computeBridgeProof(inputs: ProofInputs): Promise<string> {
  return computeProof(BRIDGE_TAG, 'bridge-first', inputs);
}

/**
 * Compares two byte arrays without an early exit on the first difference.
 * Compare hex proofs by encoding each with `TextEncoder` first. Length is not
 * secret, so differing lengths return false at once.
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

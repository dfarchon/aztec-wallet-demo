/**
 * Cookie-based account portability for cross-origin iframe embedding.
 *
 * Browser storage (IndexedDB, localStorage) is permanently partitioned by
 * top-level origin for cross-origin iframes. `requestStorageAccess()` only
 * unpartitions **cookies**. Since account secrets are small (~180 bytes each),
 * we store them in an unpartitioned cookie so the iframe can reconstruct
 * wallet state from on-chain data.
 *
 * SECURITY: The cookie payload is encrypted with AES-256-GCM using a key
 * derived from a user passphrase via PBKDF2. The server only ever sees
 * opaque ciphertext — never plaintext secrets.
 *
 * Cookie: `aztec-wallet-accounts` = base64(salt + iv + ciphertext)
 * Attributes: SameSite=None; Secure; Path=/; Max-Age=31536000 (1 year)
 */

import type { AccountType } from "@demo-wallet/shared/core";

export interface PortableAccount {
  /** AztecAddress hex string */
  address: `0x${string}`;
  /** Fr secret key as 0x-prefixed hex */
  secretKey: `0x${string}`;
  /** Fr salt as 0x-prefixed hex */
  salt: `0x${string}`;
  /** Signing key (Fq or Buffer) as hex */
  signingKey: string;
  /** Account type */
  type: AccountType;
  /** Human-readable alias */
  alias?: string;
}

const COOKIE_NAME = "aztec-wallet-accounts";
const MAX_AGE = 31536000; // 1 year in seconds
// High iteration count to compensate for short PINs.
// ~1-2 seconds per derivation on modern hardware.
const PBKDF2_ITERATIONS = 2_000_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

// ─── Crypto helpers (Web Crypto API) ───

async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encrypt(
  plaintext: string,
  passphrase: string,
): Promise<Uint8Array> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(passphrase, salt);
  const enc = new TextEncoder();
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      enc.encode(plaintext),
    ),
  );
  // Layout: [salt (16)] [iv (12)] [ciphertext (...)]
  const result = new Uint8Array(SALT_BYTES + IV_BYTES + ciphertext.length);
  result.set(salt, 0);
  result.set(iv, SALT_BYTES);
  result.set(ciphertext, SALT_BYTES + IV_BYTES);
  return result;
}

async function decrypt(
  data: Uint8Array,
  passphrase: string,
): Promise<string> {
  const salt = data.slice(0, SALT_BYTES);
  const iv = data.slice(SALT_BYTES, SALT_BYTES + IV_BYTES);
  const ciphertext = data.slice(SALT_BYTES + IV_BYTES);
  const key = await deriveKey(passphrase, salt);
  const plainBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext,
  );
  return new TextDecoder().decode(plainBuf);
}

// ─── Helpers for binary ↔ base64 (browser-safe) ───

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ─── Public API ───

/**
 * Write portable accounts to the unpartitioned cookie, encrypted with the
 * given passphrase. The server only sees opaque ciphertext.
 */
export async function writeAccountsCookie(
  accounts: PortableAccount[],
  passphrase: string,
): Promise<void> {
  const json = JSON.stringify(accounts);
  const encrypted = await encrypt(json, passphrase);
  const encoded = uint8ToBase64(encrypted);

  const parts = [
    `${COOKIE_NAME}=${encoded}`,
    `Path=/`,
    `Max-Age=${MAX_AGE}`,
    `SameSite=None`,
    `Secure`,
  ];

  document.cookie = parts.join("; ");
}

/**
 * Read and decrypt portable accounts from the cookie.
 * Returns empty array if cookie is missing or decryption fails (wrong passphrase).
 * Throws on wrong passphrase so the caller can prompt again.
 */
export async function readAccountsCookie(
  passphrase: string,
): Promise<PortableAccount[]> {
  const match = document.cookie
    .split("; ")
    .find((c) => c.startsWith(`${COOKIE_NAME}=`));

  if (!match) return [];

  const encoded = match.split("=").slice(1).join("=");
  const data = base64ToUint8(encoded);
  // decrypt throws on wrong passphrase (AES-GCM auth tag mismatch)
  const json = await decrypt(data, passphrase);
  const parsed = JSON.parse(json);
  if (!Array.isArray(parsed)) return [];
  return parsed;
}

/**
 * Check whether the accounts cookie exists (without decrypting).
 */
export function hasAccountsCookie(): boolean {
  return document.cookie
    .split("; ")
    .some((c) => c.startsWith(`${COOKIE_NAME}=`));
}

/**
 * Delete the accounts cookie.
 */
export function clearAccountsCookie(): void {
  document.cookie = `${COOKIE_NAME}=; Path=/; Max-Age=0; SameSite=None; Secure`;
}

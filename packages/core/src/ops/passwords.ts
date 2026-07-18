/**
 * Password hashing via WebCrypto PBKDF2-SHA256 (native in Workers; no wasm
 * dependency). Stored format is self-describing:
 * "pbkdf2$<iterations>$<salt hex>$<hash hex>", so the iteration count can be
 * raised later and old hashes upgraded lazily on next successful login.
 */

const ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;

const toHex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

const fromHex = (hex: string): Uint8Array => {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
};

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    keyMaterial,
    HASH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(salt);
  const hash = await derive(password, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${toHex(salt)}$${toHex(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number.parseInt(parts[1] ?? '', 10);
  const saltHex = parts[2] ?? '';
  const expectedHex = parts[3] ?? '';
  if (!Number.isFinite(iterations) || iterations < 1 || !saltHex || !expectedHex) return false;

  const actual = await derive(password, fromHex(saltHex), iterations);
  const expected = fromHex(expectedHex);
  if (actual.length !== expected.length) return false;
  // Constant-time compare; length is fixed so only content can differ.
  let diff = 0;
  for (let i = 0; i < actual.length; i++) {
    diff |= (actual[i] ?? 0) ^ (expected[i] ?? 0);
  }
  return diff === 0;
}

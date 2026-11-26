// Signing the store's list, and checking that it was signed.
//
// The store signs the exact bytes of its list with a key only its publishing step holds. A hub carries
// the matching public key and checks the signature before it reads a word of the list. Every package's
// checksum is in the list, so a signed list vouches for every package it names.
//
// Ed25519, through the runtime's own cryptography. A public key is its 32 bytes in base64. A private key
// is its PKCS #8 form in base64. A signature file is JSON, so a list can carry more than one signature
// while a key is being replaced.

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (text: string): Uint8Array<ArrayBuffer> => {
  const raw = atob(text.trim());
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
};

/** A new key pair. The public half goes in every hub; the private half goes nowhere but the store's own secret. */
export async function newKey(): Promise<{ publicKey: string; privateKey: string }> {
  const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
  return {
    publicKey: b64(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))),
    privateKey: b64(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))),
  };
}

/** Sign these exact bytes with each private key. Returns the text of the signature file. */
export async function sign(bytes: Uint8Array, privateKeys: string[]): Promise<string> {
  const signatures = [];
  for (const k of privateKeys) {
    const key = await crypto.subtle.importKey("pkcs8", unb64(k), "Ed25519", false, ["sign"]);
    signatures.push({
      sig: b64(new Uint8Array(await crypto.subtle.sign("Ed25519", key, bytes as BufferSource))),
    });
  }
  return JSON.stringify({ alg: "ed25519", signatures }, null, 2) + "\n";
}

/** Were these exact bytes signed by one of these public keys? Anything malformed is simply a no. */
export async function verify(
  bytes: Uint8Array,
  signatureFile: string,
  publicKeys: string[],
): Promise<boolean> {
  let sigs: Uint8Array<ArrayBuffer>[];
  try {
    const parsed = JSON.parse(signatureFile);
    if (parsed?.alg !== "ed25519" || !Array.isArray(parsed.signatures)) return false;
    sigs = parsed.signatures.slice(0, 8).map((s: { sig?: unknown }) => unb64(String(s?.sig ?? "")));
  } catch {
    return false;
  }
  for (const k of publicKeys) {
    let key: CryptoKey;
    try {
      key = await crypto.subtle.importKey("raw", unb64(k), "Ed25519", false, ["verify"]);
    } catch {
      continue;
    }
    for (const sig of sigs) {
      if (await crypto.subtle.verify("Ed25519", key, sig, bytes as BufferSource).catch(() => false)) {
        return true;
      }
    }
  }
  return false;
}

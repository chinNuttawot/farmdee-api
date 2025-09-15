function toBase64(u8: Uint8Array) {
    let s = "";
    u8.forEach((b) => (s += String.fromCharCode(b)));
    return btoa(s);
}
function fromBase64(b64: string) {
    const s = atob(b64);
    const u8 = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
    return u8;
}

// ถ้าต้องการตั้งจาก ENV: ใส่ [vars] PBKDF2_ITER="100000" ใน wrangler.toml หรือ .dev.vars
const DEFAULT_ITER = 100_000; // ✅ ไม่เกินเพดาน Workers

export async function hashPassword(password: string, iter?: number): Promise<string> {
    const iterations = Math.min(iter ?? DEFAULT_ITER, 100_000); // กันพลาด
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
        "raw",
        enc.encode(password),
        "PBKDF2",
        false,
        ["deriveBits", "deriveKey"]
    );
    const derived = await crypto.subtle.deriveBits(
        {
            name: "PBKDF2",
            hash: "SHA-256",
            salt,
            iterations
        },
        keyMaterial,
        256
    );
    const hash = new Uint8Array(derived);
    return `pbkdf2$sha256$${iterations}$${toBase64(salt)}$${toBase64(hash)}`;
}

export async function verifyPassword(password: string, stored: string) {
    const [alg, hashName, iterStr, saltB64, hashB64] = stored.split("$");
    if (alg !== "pbkdf2" || hashName !== "sha256") return false;
    const iterations = parseInt(iterStr, 10);
    const salt = fromBase64(saltB64);
    const expected = fromBase64(hashB64);

    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
        "raw",
        enc.encode(password),
        "PBKDF2",
        false,
        ["deriveBits", "deriveKey"]
    );
    const derived = await crypto.subtle.deriveBits(
        {
            name: "PBKDF2",
            hash: "SHA-256",
            salt,
            iterations
        },
        keyMaterial,
        256
    );
    const got = new Uint8Array(derived);
    if (got.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < got.length; i++) diff |= got[i] ^ expected[i];
    return diff === 0;
}

export function genToken(bytes = 32): string {
    const buf = new Uint8Array(bytes);
    crypto.getRandomValues(buf);
    return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

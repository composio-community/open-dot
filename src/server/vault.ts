import "server-only";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DATA_DIR, db } from "./db";
import { insertPassword, sealedPasswordFor } from "./repo";

// Passwords are AES-256-GCM encrypted at rest. The master key lives in the macOS
// Keychain on macOS, Windows user-bound DPAPI on Windows, otherwise a 0600 file. Plaintext secrets
// are only ever decrypted to type them into a page — never returned to the model or UI.

const SERVICE = "dots-openai-vault";
const g = globalThis as unknown as { __dotsVaultKey?: Buffer };

// The server is a separate Node process: use Windows' native DPAPI through PowerShell/.NET.
// Only the static script is an argument; key bytes travel through anonymous stdin/stdout pipes.
function dpapi(data: Buffer, decrypt = false): Buffer {
  const script = `Add-Type -AssemblyName System.Security; $ErrorActionPreference='Stop';
    $bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd());
    $result=[Security.Cryptography.ProtectedData]::${decrypt ? "Unprotect" : "Protect"}($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);
    [Console]::Out.Write([Convert]::ToBase64String($result))`;
  try {
    return Buffer.from(execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
      input: data.toString("base64"), encoding: "utf8", windowsHide: true, timeout: 15_000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim(), "base64");
  } catch {
    throw new Error("Windows credential protection failed. Saved data was retained; no plaintext fallback is allowed.");
  }
}

function windowsKey(): Buffer {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const protectedFile = path.join(DATA_DIR, "vault.key.dpapi");
  const legacyFile = path.join(DATA_DIR, "vault.key");
  const legacy = fs.existsSync(legacyFile) ? fs.readFileSync(legacyFile, "utf8").trim() : null;
  if (legacy !== null && !/^[a-f0-9]{64}$/i.test(legacy)) throw new Error("Invalid existing vault key; restore it before continuing.");
  if (!fs.existsSync(protectedFile)) {
    if (!legacy) {
      const existing = db().prepare("SELECT 1 FROM passwords UNION ALL SELECT 1 FROM settings WHERE key IN ('openai_key','openrouter_key','e2b_key','composio_api_key','composio_oauth') OR key GLOB 'router_config_*' LIMIT 1").get();
      if (existing) throw new Error("The existing vault key is missing. Restore it; a replacement would lose saved credentials.");
    }
    const key = legacy ? Buffer.from(legacy, "hex") : crypto.randomBytes(32);
    const protectedKey = dpapi(key);
    if (!dpapi(protectedKey, true).equals(key)) throw new Error("Windows vault protection could not be verified.");
    // Atomic publish: another process may have created the key while DPAPI was running.
    const temp = `${protectedFile}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temp, protectedKey, { flag: "wx" });
    try {
      try { fs.linkSync(temp, protectedFile); }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; }
    } finally { fs.unlinkSync(temp); }
  }
  const key = dpapi(fs.readFileSync(protectedFile), true);
  if (key.length !== 32) throw new Error("Invalid protected vault key; saved data was retained.");
  if (legacy !== null) {
    if (!key.equals(Buffer.from(legacy, "hex"))) throw new Error("Conflicting vault keys; both were retained for recovery.");
    fs.unlinkSync(legacyFile); // Remove plaintext only after the persisted DPAPI key decrypts correctly.
  }
  return key;
}

function masterKey(): Buffer {
  if (g.__dotsVaultKey) return g.__dotsVaultKey;
  if (process.platform === "win32") return (g.__dotsVaultKey = windowsKey());
  let hex: string | null = null;
  if (process.platform === "darwin") {
    try {
      hex = execFileSync("security", ["find-generic-password", "-s", SERVICE, "-a", "master", "-w"], { stdio: ["ignore", "pipe", "ignore"] })
        .toString().trim();
    } catch {
      hex = crypto.randomBytes(32).toString("hex");
      try {
        execFileSync("security", ["add-generic-password", "-s", SERVICE, "-a", "master", "-w", hex, "-U"], { stdio: "ignore" });
      } catch {
        hex = null;
      }
    }
  }
  if (!hex) {
    const file = path.join(DATA_DIR, "vault.key");
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
    hex = fs.readFileSync(file, "utf8").trim();
  }
  g.__dotsVaultKey = Buffer.from(hex, "hex");
  return g.__dotsVaultKey;
}

/** Encrypt any secret with the vault key (also used for Composio OAuth tokens). */
export function seal(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", masterKey(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64")).join(".");
}

export function unseal(sealed: string): string {
  const [iv, tag, data] = sealed.split(".").map((s) => Buffer.from(s, "base64"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", masterKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

export function savePassword(site: string, username: string, password: string) {
  return insertPassword(site.trim(), username.trim(), seal(password));
}

export function credentialFor(site: string): { site: string; username: string; password: string } | null {
  const row = sealedPasswordFor(site);
  return row ? { site: row.site, username: row.username, password: unseal(row.sealed) } : null;
}

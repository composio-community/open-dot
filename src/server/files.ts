import "server-only";
import fs from "node:fs";
import path from "node:path";
import { db, DATA_DIR, id } from "./db";
import * as computer from "./computer";
import type { Attachment } from "@/lib/types";

// Files that move between the user and a dot. The canonical copy lives in .data/files/<id>
// (for previews and downloads); a working copy goes into the dot's computer so it can use it.

const DIR = path.join(DATA_DIR, "files");
export const MAX_UPLOAD = 25 * 1024 * 1024;

type Row = { id: string; dot_id: string; name: string; mime: string; size: number; source: string; box_path: string | null; created_at: number };

const safeName = (name: string) => name.replace(/[\\/:*?"<>|\x00-\x1f]+/g, "_").replace(/^\.+/, "").slice(0, 120) || "file";

export function guessMime(name: string): string {
  const ext = path.extname(name).toLowerCase();
  return (
    {
      ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
      ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv", ".json": "application/json",
      ".html": "text/html", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".zip": "application/zip",
      ".py": "text/x-python", ".js": "text/javascript", ".ts": "text/plain",
    } as Record<string, string>
  )[ext] ?? "application/octet-stream";
}

function save(dotId: string, name: string, mime: string, data: Buffer, source: "user" | "dot", boxPath: string | null): Attachment {
  fs.mkdirSync(DIR, { recursive: true });
  const fileId = id("file");
  fs.writeFileSync(path.join(DIR, fileId), data);
  db()
    .prepare("INSERT INTO files (id, dot_id, name, mime, size, source, box_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(fileId, dotId, name, mime, data.length, source, boxPath, Date.now());
  return { id: fileId, name, mime, size: data.length };
}

/** The user attached a file: store it and put a copy in the dot's workspace under uploads/. */
export async function upload(dotId: string, name: string, mime: string, data: Buffer): Promise<Attachment & { boxPath: string }> {
  const clean = safeName(name);
  const boxPath = await computer.writeFile(dotId, `uploads/${clean}`, data);
  return { ...save(dotId, clean, mime || guessMime(clean), data, "user", boxPath), boxPath };
}

/** The dot shares a file from its computer with the user. */
export async function shareFromComputer(dotId: string, p: string): Promise<Attachment> {
  const data = await computer.readFile(dotId, p);
  if (data.length > MAX_UPLOAD * 4) throw new Error("That file is too large to share (over 100 MB).");
  const name = safeName(path.basename(p));
  return save(dotId, name, guessMime(name), data, "dot", p);
}

export function get(fileId: string): (Attachment & { dotId: string; boxPath: string | null; data: () => Buffer }) | null {
  const r = db().prepare("SELECT * FROM files WHERE id = ?").get(fileId) as Row | undefined;
  if (!r) return null;
  return {
    id: r.id, name: r.name, mime: r.mime, size: r.size, dotId: r.dot_id, boxPath: r.box_path,
    data: () => fs.readFileSync(path.join(DIR, r.id)),
  };
}

export function boxPathOf(fileId: string): string | null {
  return get(fileId)?.boxPath ?? null;
}

export function deleteForDot(dotId: string) {
  const rows = db().prepare("SELECT id FROM files WHERE dot_id = ?").all(dotId) as Row[];
  for (const r of rows) {
    try {
      fs.unlinkSync(path.join(DIR, r.id));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error("Could not delete an attachment. Close any app using it and try again.", { cause: err });
      }
    }
  }
  db().prepare("DELETE FROM files WHERE dot_id = ?").run(dotId);
}

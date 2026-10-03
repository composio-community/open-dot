// electron-builder drops every node_modules folder from extraResources, whatever the filter says.
// Copy the server's dependencies in after packing (this runs before signing, so they're signed too).
// Preserve relative links on macOS; Windows preparation supplies a materialized runtime tree.
import fs from "node:fs";
import path from "node:path";

export default async function afterPack(context) {
  const app = fs.readdirSync(context.appOutDir).find((f) => f.endsWith(".app"));
  const resources = app ? path.join(context.appOutDir, app, "Contents", "Resources") : path.join(context.appOutDir, "resources");
  const from = path.join(context.packager.projectDir, ".desktop", "server", "node_modules");
  const to = path.join(resources, "server", "node_modules");
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true, dereference: process.platform === "win32", verbatimSymlinks: process.platform !== "win32" });
  // Playwright's installation bookkeeping points at the developer checkout; the runtime does not need it.
  fs.rmSync(path.join(resources, "browser", ".links"), { recursive: true, force: true });
  console.log(`  • copied server node_modules → ${path.relative(context.appOutDir, to)}`);
}

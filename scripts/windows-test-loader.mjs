// Run actual server modules outside Next.js, replacing only its build-time server-only marker.
import { registerHooks } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { url: "data:text/javascript,export{}", shortCircuit: true };
    if (specifier.startsWith("@/")) specifier = pathToFileURL(path.join(root, "src", specifier.slice(2))).href;
    if (specifier.startsWith(".") || specifier.startsWith("file:")) {
      const url = new URL(specifier, context.parentURL);
      const base = fileURLToPath(url);
      for (const suffix of [".ts", "/index.ts"]) {
        if (fs.existsSync(base + suffix)) return { url: pathToFileURL(base + suffix).href, shortCircuit: true };
      }
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith(".ts")) return {
      format: "module", shortCircuit: true,
      source: ts.transpileModule(fs.readFileSync(fileURLToPath(url), "utf8"), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }).outputText,
    };
    return next(url, context);
  },
});

import esbuild from "esbuild";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import process from "process";

const channel = process.env.CLIP2MD_BUILD_CHANNEL || "market";
if (!["website", "market"].includes(channel))
  throw new Error("Invalid distribution channel");
const prod = process.argv[2] === "production";
const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
const sourceDir = path.resolve(
  process.env.OBSIDIAN_BUILD_SOURCE_DIR || process.cwd(),
);
const configuredOutputDir = process.env.OBSIDIAN_BUILD_OUTPUT_DIR;
const outputDir = configuredOutputDir
  ? path.resolve(configuredOutputDir)
  : prod
    ? sourceDir
    : vaultPath
      ? path.join(vaultPath, ".obsidian/plugins/clipmd")
      : sourceDir;

fs.mkdirSync(outputDir, { recursive: true });

function copyIfExists(filename) {
  const source = path.join(sourceDir, filename);
  const target = path.join(outputDir, filename);
  if (fs.existsSync(source)) {
    if (filename === "manifest.json" && source !== target) {
      const manifest = JSON.parse(fs.readFileSync(source, "utf8"));
      manifest.clip2mdChannel = channel;
      if (channel === "website") {
        manifest.clip2mdIntegratedDesktop = true;
        if (process.env.CLIP2MD_INTEGRATED_DESKTOP_VERSION)
          manifest.clip2mdIntegratedDesktopVersion =
            process.env.CLIP2MD_INTEGRATED_DESKTOP_VERSION;
      }
      fs.writeFileSync(target, JSON.stringify(manifest, null, 2) + "\n");
    } else if (source !== target) fs.copyFileSync(source, target);
  }
}

esbuild
  .build({
    entryPoints: [path.join(sourceDir, "src/main.ts")],
    bundle: true,
    // Fresh market mirrors can share the orchestrator's installed build dependencies.
    nodePaths: [
      path.join(path.dirname(fileURLToPath(import.meta.url)), "node_modules"),
    ],
    external: ["obsidian", "electron", "node:*"],
    define: { CLIP2MD_CHANNEL: JSON.stringify(channel) },
    platform: "browser",
    format: "cjs",
    target: "es2018",
    logLevel: "info",
    sourcemap: prod ? false : "inline",
    treeShaking: true,
    outfile: path.join(outputDir, "main.js"),
    minify: prod,
  })
  .then(() => {
    copyIfExists("manifest.json");
    copyIfExists("styles.css");
  })
  .catch(() => process.exit(1));

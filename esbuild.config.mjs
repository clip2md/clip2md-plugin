import esbuild from "esbuild";
import fs from "fs";
import path from "path";
import process from "process";

const prod = process.argv[2] === "production";
const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
const sourceDir = path.resolve(process.env.OBSIDIAN_BUILD_SOURCE_DIR || process.cwd());
const configuredOutputDir = process.env.OBSIDIAN_BUILD_OUTPUT_DIR;
const outputDir = configuredOutputDir
  ? path.resolve(configuredOutputDir)
  : (prod ? sourceDir : (vaultPath ? path.join(vaultPath, ".obsidian/plugins/clip2md") : sourceDir));

fs.mkdirSync(outputDir, { recursive: true });

function copyIfExists(filename) {
  const source = path.join(sourceDir, filename);
  const target = path.join(outputDir, filename);
  if (fs.existsSync(source)) {
    fs.copyFileSync(source, target);
  }
}

esbuild.build({
  entryPoints: [path.join(sourceDir, "src/main.ts")],
  bundle: true,
  external: ["obsidian"],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: path.join(outputDir, "main.js"),
  minify: prod
}).then(() => {
  copyIfExists("manifest.json");
  copyIfExists("styles.css");
}).catch(() => process.exit(1));

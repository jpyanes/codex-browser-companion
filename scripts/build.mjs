import { build, context } from "esbuild";
import { mkdir, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const srcDir = resolve(rootDir, "src");
const distDir = resolve(rootDir, "dist");

function entryPath(...segments) {
  return resolve(srcDir, ...segments);
}

function distPath(...segments) {
  return resolve(distDir, ...segments);
}

async function ensureDir(path) {
  await mkdir(path, { recursive: true });
}

async function copyTextFile(source, target) {
  await ensureDir(dirname(target));
  await copyFile(source, target);
}

async function writeManifest() {
  await copyTextFile(resolve(rootDir, "manifest.json"), distPath("manifest.json"));
}

async function copyHtmlTemplates() {
  await copyTextFile(entryPath("ui", "popup", "index.html"), distPath("popup", "index.html"));
  await copyTextFile(entryPath("ui", "sidepanel", "index.html"), distPath("sidepanel", "index.html"));
}

function sharedEsbuildOptions(overrides = {}) {
  return {
    bundle: true,
    sourcemap: true,
    charset: "utf8",
    legalComments: "none",
    logLevel: "info",
    target: ["chrome114"],
    platform: "browser",
    ...overrides,
  };
}

async function buildBackground({ watch = false } = {}) {
  const options = sharedEsbuildOptions({
    entryPoints: [entryPath("background", "service-worker.ts")],
    outfile: distPath("background.js"),
    format: "esm",
  });

  if (watch) {
    return context(options);
  }

  return build(options);
}

async function buildContent({ watch = false } = {}) {
  const options = sharedEsbuildOptions({
    entryPoints: [entryPath("content", "content-script.ts")],
    outfile: distPath("content.js"),
    format: "iife",
  });

  if (watch) {
    return context(options);
  }

  return build(options);
}

async function buildPopup({ watch = false } = {}) {
  const options = sharedEsbuildOptions({
    entryPoints: [entryPath("ui", "popup", "popup.ts")],
    outfile: distPath("popup", "popup.js"),
    format: "iife",
  });

  if (watch) {
    return context(options);
  }

  return build(options);
}

async function buildSidepanel({ watch = false } = {}) {
  const options = sharedEsbuildOptions({
    entryPoints: [entryPath("ui", "sidepanel", "panel.ts")],
    outfile: distPath("sidepanel", "panel.js"),
    format: "iife",
  });

  if (watch) {
    return context(options);
  }

  return build(options);
}

export async function buildProject({ watch = false } = {}) {
  if (!watch) {
    await rm(distDir, { recursive: true, force: true });
    await ensureDir(distDir);
    await Promise.all([writeManifest(), copyHtmlTemplates()]);
    await Promise.all([
      buildBackground(),
      buildContent(),
      buildPopup(),
      buildSidepanel(),
    ]);
    return;
  }

  await ensureDir(distDir);
  await Promise.all([writeManifest(), copyHtmlTemplates()]);

  const contexts = await Promise.all([
    buildBackground({ watch: true }),
    buildContent({ watch: true }),
    buildPopup({ watch: true }),
    buildSidepanel({ watch: true }),
  ]);

  await Promise.all(contexts.map((buildContext) => buildContext.watch()));
  console.log("Codex Browser Companion is watching for changes. Reload the extension in Chrome after each rebuild.");
}

const isMainModule = process.argv[1] ? resolve(process.cwd(), process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (isMainModule) {
  const watch = process.argv.includes("--watch");
  await buildProject({ watch });
}

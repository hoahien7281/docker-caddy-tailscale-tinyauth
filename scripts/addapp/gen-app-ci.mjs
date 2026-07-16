#!/usr/bin/env node
// scripts/addapp/gen-app-ci.mjs
// Generate CI files dedicated to user apps. Runtime smoke workflows stay static.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildableApps, ROOT } from "./app-utils.mjs";

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const CHECK = argv.includes("--check");
const SILENT = argv.includes("--silent");
const log = (...a) => { if (!SILENT) console.log(...a); };

const GH = resolve(ROOT, ".github/workflows/apps.yml");
const AZ = resolve(ROOT, ".azure/apps-pipelines.yml");
const apps = buildableApps();
let drift = false;

function ghBuildSteps() {
  if (apps.length === 0) return "      - name: No buildable apps\n        run: echo \"No buildable apps registered\"";
  return apps.map((a) => `      - name: Build ${a.name} image
        uses: docker/build-push-action@v6
        with:
          context: ${a.build.context}
          file: ${a.build.dockerfile}
          tags: ${a.build.image}
          load: true
          cache-from: type=gha,scope=${a.build.scope}
          cache-to: type=gha,mode=max,scope=${a.build.scope}`).join("\n\n");
}

function azBuildSteps() {
  if (apps.length === 0) return `      - script: echo "No buildable apps registered"
        displayName: "No buildable apps"`;
  return apps.map((a) => `      - task: Cache@2
        inputs:
          key: 'buildx | ${a.build.scope} | "$(Agent.OS)" | ${a.build.dockerfile}'
          path: $(Pipeline.Workspace)/.buildx-cache/${a.build.scope}
        displayName: "Cache buildx layers (${a.name})"

      - script: |
          docker buildx build \\
            --load \\
            --tag ${a.build.image} \\
            --cache-from type=local,src=$(Pipeline.Workspace)/.buildx-cache/${a.build.scope} \\
            --cache-to type=local,dest=$(Pipeline.Workspace)/.buildx-cache-new/${a.build.scope},mode=max \\
            --file ${a.build.dockerfile} \\
            ${a.build.context}
        displayName: "Build ${a.name} image"`).join("\n\n");
}

function githubWorkflow() {
  return `name: app-builds

on:
  push:
    branches: [main, master]
  pull_request:
  workflow_dispatch:

jobs:
  apps:
    name: Validate and build apps
    runs-on: ubuntu-latest
    if: vars.ENABLE_APP_BUILDS != 'false'
    steps:
      - name: Checkout
        uses: actions/checkout@v7

      - name: Install dependencies
        run: npm ci

      - name: Validate apps
        run: node scripts/addapp/validate-app.mjs

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

${ghBuildSteps()}
`;
}

function azurePipeline() {
  return `# .azure/apps-pipelines.yml - validate and build user apps only.

trigger:
  branches:
    include:
      - main
      - master

pr:
  branches:
    include:
      - "*"

pool:
  vmImage: ubuntu-latest

jobs:
  - job: apps
    displayName: "Validate and build apps"
    steps:
      - task: NodeTool@0
        inputs:
          versionSpec: "20.x"
        displayName: "Use Node 20"

      - script: npm ci
        displayName: "Install dependencies"

      - script: node scripts/addapp/validate-app.mjs
        displayName: "Validate apps"

      - script: |
          docker buildx create --use --name appbuilder || docker buildx use appbuilder
          docker buildx inspect --bootstrap
        displayName: "Set up Docker Buildx"

${azBuildSteps()}

      - script: |
          rm -rf $(Pipeline.Workspace)/.buildx-cache
          mv $(Pipeline.Workspace)/.buildx-cache-new $(Pipeline.Workspace)/.buildx-cache 2>/dev/null || true
        displayName: "Rotate buildx cache"
        condition: always()
`;
}

function writeIfChanged(file, content, label) {
  const cur = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (cur === content) { log(`${label}: up to date`); return; }
  if (CHECK) { drift = true; log(`${label}: OUT OF DATE`); return; }
  if (DRY_RUN) { log(`[DRY RUN] would update ${label}`); return; }
  writeFileSync(file, content);
  log(`${label}: updated`);
}

log(`Generating app CI for ${apps.length} buildable app(s)...`);
writeIfChanged(GH, githubWorkflow(), ".github/workflows/apps.yml");
writeIfChanged(AZ, azurePipeline(), ".azure/apps-pipelines.yml");

if (CHECK && drift) {
  console.error("App CI files are out of date. Run: node scripts/addapp/gen-app-ci.mjs");
  process.exit(1);
}
log("Done.");

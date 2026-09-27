/**
 * opencode-project-knowledge — OpenCode plugin (ESM, documented format).
 *
 * Exposes `project_context`, `project_bootstrap`, `project_status`, and
 * `project_refresh` custom tools.
 *
 * Format follows https://opencode.ai/docs/plugins/ : the module exports an
 * async plugin function; OpenCode calls it with context and registers the
 * returned hooks. No static external imports, so the module loads even when
 * optional dependencies are not installed yet — the tool is then simply
 * absent until `bun install` runs (automatic at OpenCode startup when
 * <config>/package.json lists the dependency) and OpenCode restarts.
 *
 * Engines (../project-knowledge/*.js) are imported lazily via explicit file
 * URLs, so a missing engine degrades to a message, never a crash.
 */

const engineUrl = new URL("../project-knowledge/context.js", import.meta.url).href;
const bootstrapUrl = new URL("../project-knowledge/bootstrap.mjs", import.meta.url).href;
const statusUrl = new URL("../project-knowledge/status.js", import.meta.url).href;
const refreshUrl = new URL("../project-knowledge/refresh.js", import.meta.url).href;

async function loadEngine() {
  try {
    const mod = await import(engineUrl);
    return mod.default ?? mod;
  } catch {
    return null;
  }
}

async function loadBootstrap() {
  try {
    const mod = await import(bootstrapUrl);
    return mod.default ?? mod;
  } catch {
    return null;
  }
}

async function loadStatus() {
  try {
    const mod = await import(statusUrl);
    return mod.default ?? mod;
  } catch {
    return null;
  }
}

async function loadRefresh() {
  try {
    const mod = await import(refreshUrl);
    return mod.default ?? mod;
  } catch {
    return null;
  }
}

async function loadToolHelper() {
  try {
    return (await import("@opencode-ai/plugin")).tool;
  } catch {
    return null; // dependency not installed yet — degrade quietly
  }
}

const ProjectKnowledgePlugin = async () => {
  const tool = await loadToolHelper();
  if (!tool) return {};
  return {
    tool: {
      project_context: tool({
        description:
          "Compact PROJECT CONTEXT (~35 lines) for a repository from its .project/ knowledge base. Call this before substantial coding work in a repo; then read only the touched subsystem's .project/*.md detail docs.",
        args: {
          root: tool.schema
            .string()
            .optional()
            .describe("Repository root (defaults to the session directory)"),
          task: tool.schema
            .string()
            .optional()
            .describe("One-line task scope, used to pick the relevant subsystem"),
        },
        async execute(args, context) {
          const eng = await loadEngine();
          const root = (args && args.root) || (context && context.directory) || process.cwd();
          if (!eng || typeof eng.buildContext !== "function") {
            return `Project knowledge engine unavailable for ${root}.`;
          }
          try {
            return eng.buildContext(root, (args && args.task) || "").text;
          } catch (err) {
            return `Project knowledge unavailable for ${root}: ${String((err && err.message) || err)}`;
          }
        },
      }),
      project_bootstrap: tool({
        description:
          "Create .project/ knowledge baseline in a repository (safe: skips existing docs unless force, never touches source, never commits). Use when .project/ is missing; then fill (agent) stubs by reading source and run mechanical sync.",
        args: {
          root: tool.schema
            .string()
            .optional()
            .describe("Repository root (defaults to the session directory)"),
          force: tool.schema
            .boolean()
            .optional()
            .describe("Overwrite docs (backs up to .project/.backup/<ts>/ first)"),
          baselineOnly: tool.schema
            .boolean()
            .optional()
            .describe("Repair knowledge.json baseline metadata only, leave docs alone"),
          dryRun: tool.schema
            .boolean()
            .optional()
            .describe("Preview planned actions, write nothing"),
          noHooks: tool.schema
            .boolean()
            .optional()
            .describe("Skip installing local git hooks"),
        },
        async execute(args, context) {
          const mod = await loadBootstrap();
          const root = (args && args.root) || (context && context.directory) || process.cwd();
          const run = mod && (mod.bootstrap || (mod.default && mod.default.bootstrap) || (typeof mod === "function" && mod));
          if (!run || typeof run !== "function") {
            return `Project knowledge bootstrap unavailable for ${root}.`;
          }
          try {
            const res = run(root, {
              force: Boolean(args && args.force),
              baselineOnly: Boolean(args && args.baselineOnly),
              dryRun: Boolean(args && args.dryRun),
              noHooks: Boolean(args && args.noHooks),
            });
            const bits = [];
            bits.push(`${res.dryRun ? "DRY RUN — no changes written. " : ""}Bootstrapped ${res.root}`);
            bits.push(`type: ${res.detection.primary}${res.detection.mixed ? " (mixed)" : ""}`);
            bits.push(`created: ${res.created.join(", ") || "(none)"}`);
            bits.push(`skipped: ${res.skipped.join(", ") || "(none)"}`);
            if (res.overwritten.length) bits.push(`overwritten: ${res.overwritten.join(", ")}`);
            if (res.backedUp.length) bits.push(`backed up to ${res.backupDir}: ${res.backedUp.join(", ")}`);
            if (res.agentsCreated) bits.push("created: AGENTS.md (root, was missing)");
            bits.push("next: fill (agent) stubs by reading source (keep FACT/INFERENCE/UNCERTAINTY), then run mechanical sync.");
            return bits.join("\n");
          } catch (err) {
            return `Project knowledge bootstrap failed for ${root}: ${String((err && err.message) || err)}`;
          }
        },
      }),
      project_status: tool({
        description:
          "Read-only project-knowledge health report (age, baseline, changed files, stale sections, low-confidence, missing docs). Never modifies files.",
        args: {
          root: tool.schema
            .string()
            .optional()
            .describe("Repository root (defaults to the session directory)"),
        },
        async execute(args, context) {
          const mod = await loadStatus();
          const root = (args && args.root) || (context && context.directory) || process.cwd();
          const run = mod && (mod.status || (mod.default && mod.default.status) || (typeof mod === "function" && mod));
          if (!run || typeof run !== "function") {
            return `Project knowledge status unavailable for ${root}.`;
          }
          try {
            const s = run(root);
            const L = [];
            L.push(`root: ${s.root}`);
            L.push(`detected type: ${s.projectType} (${(s.languages || []).join(", ") || "n/a"})`);
            L.push(`knowledge age: ${s.knowledgeAge}`);
            L.push(`baseline: ${s.baseline ? `${s.baseline.commit || "n/a"} @ ${s.baseline.timestamp || "n/a"}` : "none"}`);
            L.push(`changed files: ${s.changedFiles === null ? "git unavailable" : (s.changedFiles.length ? s.changedFiles.slice(0, 10).join(", ") : "clean")}`);
            L.push(`stale sections: ${s.staleSections.length ? s.staleSections.join("; ") : "none"}`);
            L.push(`low-confidence: ${s.lowConfidence.length ? s.lowConfidence.join(", ") : "none"}`);
            L.push(`missing knowledge: ${s.missingKnowledge.length ? s.missingKnowledge.join(", ") : "none"}`);
            if (s.malformed) L.push(`malformed: knowledge.json: ${s.malformed}`);
            if (s.staleMalformed) L.push(`malformed: state/stale.json: ${s.staleMalformed}`);
            return L.join("\n");
          } catch (err) {
            return `Project knowledge status failed for ${root}: ${String((err && err.message) || err)}`;
          }
        },
      }),
      project_refresh: tool({
        description:
          "Mark stale knowledge modules from git changes and update knowledge.json baseline metadata (docs left for targeted agent update). Prefer dryRun first to preview.",
        args: {
          root: tool.schema
            .string()
            .optional()
            .describe("Repository root (defaults to the session directory)"),
          markOnly: tool.schema
            .boolean()
            .optional()
            .describe("Only mark stale, skip baseline metadata update"),
          clear: tool.schema
            .boolean()
            .optional()
            .describe("Clear resolved stale state"),
          dryRun: tool.schema
            .boolean()
            .optional()
            .describe("Preview affected modules, write nothing"),
        },
        async execute(args, context) {
          const mod = await loadRefresh();
          const root = (args && args.root) || (context && context.directory) || process.cwd();
          const run = mod && (mod.refresh || (mod.default && mod.default.refresh) || (typeof mod === "function" && mod));
          if (!run || typeof run !== "function") {
            return `Project knowledge refresh unavailable for ${root}.`;
          }
          try {
            const res = run(root, {
              markOnly: Boolean(args && args.markOnly),
              clear: Boolean(args && args.clear),
              dryRun: Boolean(args && args.dryRun),
            });
            const bits = [];
            if (res.dryRun) bits.push("DRY RUN — no changes written.");
            bits.push(`refresh: ${res.root}`);
            for (const a of res.actions) bits.push(`- ${a}`);
            bits.push(res.stale.length ? `stale now: ${res.stale.join(" | ")}` : "stale: none");
            return bits.join("\n");
          } catch (err) {
            return `Project knowledge refresh failed for ${root}: ${String((err && err.message) || err)}`;
          }
        },
      }),
    },
  };
};

// Stable plugin identity: single default export (V1 module shape).
// Keep exactly one export — a second (named) export would register the
// plugin twice on runtimes that also scan named exports.
export default {
  id: "lore",
  server: ProjectKnowledgePlugin,
};

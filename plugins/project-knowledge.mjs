/**
 * opencode-project-knowledge — OpenCode plugin (ESM, documented format).
 *
 * Exposes a `project_context` custom tool: compact PROJECT CONTEXT (~35 lines)
 * for a repository from its .project/ knowledge base.
 *
 * Format follows https://opencode.ai/docs/plugins/ : the module exports an
 * async plugin function; OpenCode calls it with context and registers the
 * returned hooks. No static external imports, so the module loads even when
 * optional dependencies are not installed yet — the tool is then simply
 * absent until `bun install` runs (automatic at OpenCode startup when
 * <config>/package.json lists the dependency) and OpenCode restarts.
 *
 * The engine (../project-knowledge/context.js) is imported lazily via an
 * explicit file URL, so a missing engine degrades to a message, never a crash.
 */

const engineUrl = new URL("../project-knowledge/context.js", import.meta.url).href;

async function loadEngine() {
  try {
    const mod = await import(engineUrl);
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

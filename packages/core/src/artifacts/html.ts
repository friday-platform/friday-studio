/**
 * Artifact HTML rendering utilities
 *
 * Pure TypeScript functions for rendering artifact data to HTML strings.
 * Used by web client share functionality.
 */

/**
 * Escape HTML special characters to prevent XSS
 */
export function escapeHTML(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/** Common plan shape accepted by renderWorkspacePlanHTML. */
interface RenderablePlan {
  workspace: { name: string; purpose: string };
  signals: Array<{ id: string; description?: string }>;
  agents: Array<{ id: string; name: string; description?: string }>;
  jobs: Array<{ name: string; triggerSignalId: string; steps: Array<{ agentId: string }> }>;
}

/**
 * Render a workspace plan to HTML.
 */
export function renderWorkspacePlanHTML(plan: RenderablePlan): string {
  const parts: string[] = [];

  parts.push(`<h1>${escapeHTML(plan.workspace.name)}</h1>`);
  parts.push(`<p class="purpose">${escapeHTML(plan.workspace.purpose)}</p>`);

  for (const job of plan.jobs) {
    const signal = plan.signals.find((s) => s.id === job.triggerSignalId);

    parts.push(`<div class="job">`);
    parts.push(`<h2>${escapeHTML(job.name)}</h2>`);
    if (signal?.description) {
      parts.push(`<p class="signal-description">${escapeHTML(signal.description)}</p>`);
    }

    parts.push(`<ul class="steps">`);
    for (const step of job.steps) {
      const agent = plan.agents.find((a) => a.id === step.agentId);
      parts.push(`<li>`);
      if (agent) {
        parts.push(`<strong>${escapeHTML(agent.name)}</strong>`);
        if (agent.description) {
          parts.push(`<p>${escapeHTML(agent.description)}</p>`);
        }
      }
      parts.push(`</li>`);
    }
    parts.push(`</ul>`);
    parts.push(`</div>`);
  }

  return parts.join("\n");
}

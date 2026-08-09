import { and, count, eq, inArray, sql } from "drizzle-orm";

import type { Database } from "@/db/client.js";
import { llmUsageTable, workspacesTable } from "@/db/schema.js";
import type { TeamRole } from "@/teams/team-context.js";
import { workspaceVisibilityCondition } from "@/workspaces/member-access.js";

export interface AiUsageProject {
  workspaceId: string;
  name: string;
  slug: string;
  repo: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface AiUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  projects: AiUsageProject[];
}

export const execute = async (input: {
  db: Database;
  teamId: string;
  userId: string;
  role: TeamRole;
}): Promise<AiUsage> => {
  const workspaces = await input.db
    .select({
      id: workspacesTable.id,
      name: workspacesTable.name,
      slug: workspacesTable.slug,
      repo: workspacesTable.repoFullName,
    })
    .from(workspacesTable)
    .where(
      and(
        eq(workspacesTable.teamId, input.teamId),
        workspaceVisibilityCondition({ userId: input.userId, role: input.role }),
      ),
    );
  const linked = workspaces.filter(
    (workspace): workspace is typeof workspace & { repo: string } =>
      workspace.repo !== null && workspace.repo.trim().length > 0,
  );
  const repos = [...new Set(linked.map((workspace) => workspace.repo))];
  if (repos.length === 0) {
    return {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      projects: [],
    };
  }

  const usageRows = await input.db
    .select({
      repo: llmUsageTable.repo,
      calls: count(),
      inputTokens: sql<number>`coalesce(sum(${llmUsageTable.inputTokens}), 0)`.mapWith(
        Number,
      ),
      outputTokens:
        sql<number>`coalesce(sum(${llmUsageTable.outputTokens}), 0)`.mapWith(Number),
    })
    .from(llmUsageTable)
    .where(inArray(llmUsageTable.repo, repos))
    .groupBy(llmUsageTable.repo);
  const usageByRepo = new Map(usageRows.map((row) => [row.repo, row]));
  const projects = linked.map((workspace) => {
    const usage = usageByRepo.get(workspace.repo) ?? {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    return {
      workspaceId: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      repo: workspace.repo,
      calls: usage.calls,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.inputTokens + usage.outputTokens,
    };
  });

  return {
    calls: projects.reduce((total, project) => total + project.calls, 0),
    inputTokens: projects.reduce((total, project) => total + project.inputTokens, 0),
    outputTokens: projects.reduce((total, project) => total + project.outputTokens, 0),
    totalTokens: projects.reduce((total, project) => total + project.totalTokens, 0),
    projects,
  };
};

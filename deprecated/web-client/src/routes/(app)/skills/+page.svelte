<script lang="ts">
  import { createMutation, createQuery } from "@tanstack/svelte-query";
  import {
    createColumnHelper,
    createTable,
    getCoreRowModel,
    renderComponent,
  } from "@tanstack/svelte-table";
  import { goto } from "$app/navigation";
  import { getAppContext } from "$lib/app-context.svelte";
  import Button from "$lib/components/button.svelte";
  import { Table } from "$lib/components/table";
  import { createSkill, listSkills } from "$lib/queries/skills";
  import InfoColumn from "./(components)/info-column.svelte";
  import SkillColumn from "./(components)/skill-column.svelte";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  const skillsQuery = createQuery(() => ({
    queryKey: ["skills"],
    queryFn: () => listSkills("createdAt"),
    initialData: { skills: data.skills },
    select: (data) => data.skills,
  }));

  const skills = $derived(skillsQuery.data ?? []);
  const appCtx = getAppContext();

  type Skill = (typeof skills)[number];

  const createMut = createMutation(() => ({
    mutationFn: () => createSkill(),
    onSuccess: async ({ skillId }) => {
      await goto(appCtx.routes.skills.item(skillId));
    },
  }));

  const columnHelper = createColumnHelper<Skill>();

  const table = createTable({
    get data() {
      return skills;
    },
    columns: [
      columnHelper.display({
        id: "skill",
        header: "Skill",
        cell: (info) =>
          renderComponent(SkillColumn, {
            name: info.row.original.name ?? "Untitled skill",
            description: info.row.original.description,
            muted: !info.row.original.name,
          }),
        meta: { minWidth: "0" },
      }),
      columnHelper.display({
        id: "info",
        header: "Info",
        cell: (info) =>
          renderComponent(InfoColumn, {
            disabled: info.row.original.disabled,
            needsAttention: !info.row.original.name || !info.row.original.description,
          }),
        meta: { minWidth: "0", shrink: true },
      }),
    ],
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.id,
  });

  function skillPath(item: Skill): string {
    if (item.name) {
      return appCtx.routes.skills.item(item.skillId, item.name);
    }
    return appCtx.routes.skills.item(item.skillId);
  }
</script>

<div class="page">
  <div class="header">
    <div class="header-row">
      <h1>Skills</h1>
      <Button onclick={() => createMut.mutate()} disabled={createMut.isPending}>New Skill</Button>
    </div>
    <p>Manage skills available to spaces and conversations.</p>
  </div>

  {#if skills.length === 0}
    <p class="empty">No skills yet</p>
  {:else}
    <Table.Root {table} padded hideHeader rowSize="large" rowPath={(item) => skillPath(item)} />
  {/if}
</div>

<style>
  .page {
    overflow: auto;
    padding-block: var(--size-12);
    padding-inline: var(--size-14);
  }

  .header {
    margin-block-end: var(--size-6);
  }

  .header-row {
    align-items: center;
    display: flex;
    justify-content: space-between;
  }

  h1 {
    font-size: var(--font-size-8);
    line-height: var(--font-lineheight-1);
    font-weight: var(--font-weight-6);
  }

  p {
    font-size: var(--font-size-5);
    font-weight: var(--font-weight-5);
    line-height: var(--font-lineheight-1);
    margin-block: var(--size-1) 0;
    opacity: 0.6;
  }

  .empty {
    color: var(--text-3);
    font-size: var(--font-size-3);
  }
</style>

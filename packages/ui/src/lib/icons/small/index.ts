import type { Component } from "svelte";
import CaretDown from "./caret-down.svelte";
import CaretRight from "./caret-right.svelte";
import Check from "./check.svelte";
import Close from "./close.svelte";
import File from "./file.svelte";
import Folder from "./folder.svelte";
import Plus from "./plus.svelte";
import Progress from "./progress.svelte";
import Search from "./search.svelte";
import Skills from "./skills.svelte";

export const IconSmall: Record<string, Component> = {
  CaretDown,
  CaretRight,
  Check,
  Close,
  File,
  Folder,
  Plus,
  Progress,
  Search,
  Skills,
};

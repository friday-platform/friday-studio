import type { Component } from "svelte";
import CaretDown from "./caret-down.svelte";
import CaretRight from "./caret-right.svelte";
import ChevronLeft from "./chevron-left.svelte";
import Check from "./check.svelte";
import CheckCircle from "./check-circle.svelte";
import ChevronDown from "./chevron-down.svelte";
import Clock from "./clock.svelte";
import ChevronRight from "./chevron-right.svelte";
import Close from "./close.svelte";
import ExternalLink from "./external-link.svelte";
import File from "./file.svelte";
import Folder from "./folder.svelte";
import Plus from "./plus.svelte";
import Progress from "./progress.svelte";
import Search from "./search.svelte";
import Skills from "./skills.svelte";
import XCircle from "./x-circle.svelte";

export const IconSmall: Record<string, Component> = {
  CaretDown,
  CaretRight,
  Check,
  ChevronLeft,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Clock,
  Close,
  ExternalLink,
  File,
  Folder,
  Plus,
  Progress,
  Search,
  Skills,
  XCircle,
};

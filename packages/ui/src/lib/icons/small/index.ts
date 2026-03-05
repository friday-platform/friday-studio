import type { Component } from "svelte";
import CaretDown from "./caret-down.svelte";
import CaretRight from "./caret-right.svelte";
import Check from "./check.svelte";
import Close from "./close.svelte";
import Plus from "./plus.svelte";

export const IconSmall: Record<string, Component> = { CaretDown, CaretRight, Check, Close, Plus };

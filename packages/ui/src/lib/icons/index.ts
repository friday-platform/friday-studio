import type { Component } from "svelte";
import Close from "./close.svelte";
import EyeClosed from "./eye-closed.svelte";
import Eye from "./eye.svelte";
import Plus from "./plus.svelte";
import TriangleRight from "./triangle-right.svelte";

export const Icons: Record<string, Component> = { Close, Eye, EyeClosed, Plus, TriangleRight };

export { IconSmall } from "./small/index.js";

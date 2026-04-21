import type { Component } from "svelte";
import Close from "./close.svelte";
import DotFilled from "./dot-filled.svelte";
import DotOpen from "./dot-open.svelte";
import EyeClosed from "./eye-closed.svelte";
import Eye from "./eye.svelte";
import Pencil from "./pencil.svelte";
import Plus from "./plus.svelte";
import TriangleRight from "./triangle-right.svelte";
import TripleDots from "./triple-dots.svelte";

export const Icons: Record<string, Component> = { Close, DotFilled, DotOpen, Eye, EyeClosed, Pencil, Plus, TriangleRight, TripleDots };

export { IconLarge } from "./large/index.js";
export { IconSmall } from "./small/index.js";

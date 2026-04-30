import type { Component } from "svelte";
import Close from "./close.svelte";
import CodeBracketSquare from "./code-bracket-square.svelte";
import DocumentArrowUp from "./document-arrow-up.svelte";
import DocumentText from "./document-text.svelte";
import DotFilled from "./dot-filled.svelte";
import FolderOpen from "./folder-open.svelte";
import DotOpen from "./dot-open.svelte";
import EyeClosed from "./eye-closed.svelte";
import Eye from "./eye.svelte";
import GlobeAlt from "./globe-alt.svelte";
import Link from "./link.svelte";
import Bolt from "./bolt.svelte";
import Bookmark from "./bookmark.svelte";
import Pencil from "./pencil.svelte";
import RectangleStack from "./rectangle-stack.svelte";
import Plus from "./plus.svelte";
import TriangleRight from "./triangle-right.svelte";
import TripleDots from "./triple-dots.svelte";
import Pause from "./pause.svelte";

export const Icons: Record<string, Component> = { Bolt, Bookmark, Close, CodeBracketSquare, DocumentArrowUp, DocumentText, DotFilled, DotOpen, Eye, EyeClosed, FolderOpen, GlobeAlt, Link, Pause, Pencil, Plus, RectangleStack, TriangleRight, TripleDots };

export { IconLarge } from "./large/index.js";
export { IconSmall } from "./small/index.js";

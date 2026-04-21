import type { Component } from "svelte";
import Chip from "./chip.svelte";
import Compass from "./compass.svelte";
import DiamondCheck from "./diamond-check.svelte";
import Gear from "./gear.svelte";
import OpenSquare from "./open-square.svelte";
import SpeechBubble from "./speech-bubble.svelte";
import Target from "./target.svelte";
import Write from "./write.svelte";

export const IconLarge: Record<string, Component> = {
  Chip,
  Compass,
  DiamondCheck,
  Gear,
  OpenSquare,
  SpeechBubble,
  Target,
  Write,
};

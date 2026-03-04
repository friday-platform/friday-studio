import { getContext, setContext } from "svelte";
import type { FeatureFlags } from "./feature-flags";

const KEY = Symbol("feature-flags");

export function setFeatureFlagsContext(flags: FeatureFlags) {
  return setContext(KEY, flags);
}

export function getFeatureFlags(): FeatureFlags {
  return getContext<FeatureFlags>(KEY);
}

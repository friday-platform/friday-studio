import { getContext, setContext } from "svelte";

const KEY = Symbol();

class SegmentedControlContext {
  public variant = $state<"filled" | "outline">("filled");

  constructor(public variantProp: "filled" | "outline") {
    this.variant = variantProp;
  }
}

type Input = { variant: "filled" | "outline" };

export function createSegmentControllerContext({ variant }: Input) {
  const ctx = new SegmentedControlContext(variant);

  return setContext(KEY, ctx);
}

export function getSegmentControllerContext() {
  return getContext<ReturnType<typeof createSegmentControllerContext>>(KEY);
}

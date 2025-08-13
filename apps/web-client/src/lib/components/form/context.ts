import { nanoid } from "nanoid";
import { getContext as _getContext, setContext } from "svelte";
import type { Layout } from "./types.ts";

export const FORM_CONTEXT = Symbol();
export const FIELD_CONTEXT = Symbol();

export function createContext(args: { layout: Layout }) {
  const ctx = args;
  setContext(FORM_CONTEXT, ctx);
  return ctx;
}

export function getContext() {
  return _getContext<ReturnType<typeof createContext>>(FORM_CONTEXT);
}

export function createFieldContext() {
  const ctx = { id: `field-${nanoid()}` };
  setContext(FIELD_CONTEXT, ctx);
  return ctx;
}

export function getFieldContext() {
  return _getContext<ReturnType<typeof createFieldContext>>(FIELD_CONTEXT);
}

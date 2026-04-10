import type { Command, GunshiParamsConstraint, SubCommandable } from "gunshi";

/**
 * Create an internal alias for a command.
 * The alias routes to the same `run` handler but is hidden from help output
 * (gunshi's `internal: true` flag filters it from the rendered command list).
 *
 * Returns SubCommandable (the loose structural type gunshi uses for subCommands)
 * to avoid type instantiation issues with nested generics.
 */
export function alias<T extends GunshiParamsConstraint>(cmd: Command<T>): SubCommandable {
  return { ...cmd, internal: true };
}

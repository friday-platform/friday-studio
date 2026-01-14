/**
 * Session timeline utilities.
 *
 * This module re-exports DigestStep from @atlas/core for use in timeline components.
 * Previously contained a wrapper type (StepGroup) that added unnecessary nesting -
 * simplified in FT-6od to use DigestStep directly.
 */

export type { DigestStep, DigestToolCall } from "@atlas/core/session/build-session-digest";

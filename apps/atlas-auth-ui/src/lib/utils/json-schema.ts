/**
 * Represents any possible JSON value
 */
export type JsonValue = number | string | boolean | null | { [k: string]: JsonValue } | JsonValue[];

import { AsyncLocalStorage } from "node:async_hooks";

const authTokenStorage = new AsyncLocalStorage<string>();

export function getAuthToken(): string {
  const token = authTokenStorage.getStore();
  if (token === undefined) {
    throw new Error("getAuthToken() called outside request context");
  }
  return token;
}

export function runWithAuthToken<T>(token: string, fn: () => T): T {
  return authTokenStorage.run(token, fn);
}

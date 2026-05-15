/**
 * AI SDK's `DefaultChatTransport` builds URLs as `${api}/${id}/stream` (for
 * `resumeStream`) and `${api}/${id}` (for `stopStream`) without URL-encoding
 * the chat id. GitHub-sourced chat ids contain literal `/` (e.g.
 * `github:owner/repo:issue:N`); the raw path then splits across segments and
 * the daemon's `:chatId` route 404s.
 *
 * `wrapEncodeChatIdFetch` re-encodes the chat-id segment of any URL that
 * matches `/chat/<rawId>` before delegating to the underlying fetch. It is
 * a no-op when the id is already URL-safe (`encodeURIComponent` is identity)
 * or when the URL doesn't contain the raw id — so non-github chats and
 * non-chat fetches pass through untouched.
 */

type AnyFetch = (input: Request | URL | string, init?: RequestInit) => Promise<Response>;

export function wrapEncodeChatIdFetch(inner: AnyFetch, getChatId: () => string): AnyFetch {
  return (input, init) => {
    const cid = getChatId();
    const encoded = encodeURIComponent(cid);
    if (encoded === cid) return inner(input, init);

    const rawSeg = `/chat/${cid}`;
    const encSeg = `/chat/${encoded}`;
    const rewrite = (url: string) => (url.includes(rawSeg) ? url.replace(rawSeg, encSeg) : url);

    if (typeof input === "string") {
      return inner(rewrite(input), init);
    }
    if (input instanceof URL) {
      const current = input.toString();
      const next = rewrite(current);
      return inner(next === current ? input : new URL(next), init);
    }
    const next = rewrite(input.url);
    return inner(next === input.url ? input : new Request(next, input), init);
  };
}

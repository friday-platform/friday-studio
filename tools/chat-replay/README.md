# Friday Chat Replay

Standalone SvelteKit replay app using the same JS toolchain and real chat UI components as `tools/agent-playground`.

## Run

```bash
cd chat-replay
npm run dev
```

Open:

```txt
http://127.0.0.1:5210/
```

Paste 1+ chat URLs into the form, one per line. Submitting updates the URL to repeated `?chat=...` query params, so the replay can be shared/bookmarked. You can also open directly with query params.

# traefik

Custom Traefik image with local plugins for Atlas.

## Plugins

### extractuserid

Middleware that validates JWT tokens and extracts the user ID (sub claim) into a header (`X-Atlas-User-ID`).

## Development

The plugin has its own go.mod with vendored dependencies. To update dependencies:

```bash
cd extractuserid
go mod tidy
go mod vendor
```

Run tests:

```bash
cd extractuserid
make test
```

# @atlas/mcp-server TODOs

This file tracks tasks and future work for the MCP server package.

## High Priority

### Convert Read-Only Tools to Resources

- [ ] Convert all read-only listing and description tools to MCP resources
  - [ ] `atlas:workspace_list` → `atlas://workspaces` resource
  - [ ] `atlas:workspace_describe` → `atlas://workspaces/{id}` resource
  - [ ] `atlas:agents_list` → `atlas://agents` resource
  - [ ] `atlas:agents_describe` → `atlas://agents/{id}` resource
  - [ ] `atlas:jobs_list` → `atlas://jobs` resource
  - [ ] `atlas:jobs_describe` → `atlas://jobs/{name}` resource
  - [ ] `atlas:signals_list` → `atlas://signals` resource
  - [ ] `atlas:session_describe` → `atlas://sessions/{id}` resource
  - [ ] `atlas:library_list` → `atlas://library` resource
  - [ ] `atlas:library_get` → `atlas://library/{id}` resource
  - [ ] `atlas:library_stats` → `atlas://library/stats` resource
  - [ ] `atlas:library_templates` → `atlas://library/templates` resource
  - [ ] `atlas:drafts_list` → `atlas://drafts` resource
  - [ ] `atlas:drafts_show` → `atlas://drafts/{id}` resource

**Rationale**: Resources are more appropriate for read-only data access. Tools should be reserved
for actions that modify state or trigger operations.

### Resource Implementation Enhancements

- [ ] Add support for parameterized resource URIs (e.g., `atlas://workspaces/{id}`)
- [ ] Implement resource URI routing/matching system
- [ ] Add resource caching layer for frequently accessed data
- [ ] Support resource subscriptions for real-time updates (future MCP feature)

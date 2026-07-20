# Tenancy and Authentication Frontier SDD

Document status: design-sealed
Current frontier: local single-user mode with a tenant-ready migration path
Bounded context: deployment modes, tenant ownership, authentication,
authorization, source credentials, analytics isolation, and connector execution

## Problem

Tokenomics currently relies on a loopback-only single-user trust boundary. The
web server has one report cache, one Sync controller, one configuration writer,
and database-wide import and pricing revisions. A future Source Registry adds
remote credentials, retained artifacts, background Sync, and mutable ownership.
Adding those surfaces before defining tenancy would force a later migration
across sources, secrets, generations, caches, deduplication, and audit history.

The product must preserve the zero-login local workflow while creating an
explicit path to an authenticated hosted deployment.

## Admitted Surface

- `local` remains the default deployment mode.
- Local mode binds to loopback by default and has one implicit workspace whose
  actor has owner capability.
- Existing loopback and same-origin mutation guards remain authoritative until
  server-mode authentication and authorization are implemented.
- ClickHouse import generations remain marker-last and report reads remain
  pinned to one committed generation.
- Source, application, database, and future agent authentication are distinct
  bounded contexts.
- The Source Registry may be implemented in local mode before hosted Auth only
  when its ownership, Sync, cache, configuration, and secret interfaces accept
  an explicit workspace context.
- Local credentials may be referenced through an OS-backed SecretStore. Secret
  material is not stored in ClickHouse analytics/configuration tables.

## Rejected Surface

- Treating a `tenant_id` column by itself as tenant isolation.
- Enabling anonymous mutable APIs when the server is bound beyond loopback.
- Reusing the loopback custom-action header as user authentication.
- Storing cloud access keys, private keys, refresh tokens, session cookies, or
  password-equivalent values in ClickHouse.
- Sharing a report cache, Sync controller, write lock, progress stream, or
  background job across tenants without an explicit tenant key.
- Cross-tenant logical or physical session deduplication.
- Inferring a tenant from an email address, filesystem path, project name,
  source credential, or provider account.
- Treating a server-local filesystem source as a user's workstation folder.
- Project-level ACL claims before workspace-level isolation is implemented and
  falsified with two-tenant tests.
- Hand-rolled passwords, OAuth protocols, or cryptographic session formats.

## Guard-Only Future

### Deployment Modes

- `local`: implicit workspace, implicit owner, no login, loopback mutation.
- `server`: explicit base URL, TLS or trusted TLS termination, secure sessions,
  authenticated requests, workspace membership, authorization, and audit.
- Server mode must refuse startup when required Auth/session configuration is
  missing. Binding `0.0.0.0` never silently enables anonymous server mode.

### Identity and Authorization

- A stable opaque `workspace_id` is the tenant boundary.
- Users join workspaces through memberships. Initial roles are `owner`,
  `admin`, `editor`, and `viewer`.
- Owners/admins manage membership and destructive retention operations.
- Editors manage sources, pricing, and Sync. Viewers are read-only.
- AuthN establishes the actor. AuthZ evaluates actor, workspace, action, and
  resource; route handlers do not infer authorization from UI visibility.
- Generic OIDC is the preferred first authentication surface. Provider choice
  and session library remain unselected until implementation planning.

### Control and Analytics Planes

- A transactional ControlStore owns users, sessions, memberships, source
  definitions, credential metadata, job state, and audit events.
- Local mode may implement ControlStore with SQLite. Hosted mode is expected to
  use PostgreSQL or another admitted transactional store.
- ClickHouse remains the analytics/data plane. Every shared-table row and query
  is scoped to one workspace, or the implementation uses an equivalently
  isolated physical layout justified by the falsifier roster.
- Pricing overrides and analytics settings are workspace-scoped. Packaged
  standard prices may be globally seeded but never mutated globally by a
  tenant write.

### Request and Job Context

- Every storage, report, timeline, configuration, source, and session-viewer
  operation receives an explicit context containing deployment mode,
  workspace, actor, and capabilities.
- Report caches, timeline caches, Sync locks, configuration locks, progress
  subscriptions, job queues, and generation manifests are workspace-scoped.
- Background jobs capture the workspace and service identity at enqueue time
  and re-authorize destructive actions at execution time.

### Secrets and Connector Execution

- SecretStore is separate from ControlStore and returns bounded credential
  handles, not values suitable for API serialization.
- Local SecretStore uses OS keychain/secret-service facilities where available.
- Hosted SecretStore uses KMS/Vault/managed secret storage with workspace-scoped
  references and rotation metadata.
- Application Auth, source Auth, ClickHouse Auth, and collector-agent Auth use
  separate credentials and expiration/revocation paths.
- A source records where its connector runs: embedded local process,
  server-side worker, or authenticated collector agent.
- Hosted access to sessions on a user's workstation requires an authenticated
  agent or explicit upload. The hosted server cannot browse the user's local
  filesystem directly.

### Deduplication and Retention

- Deduplication is scoped to one workspace. Equal hashes in different tenants
  do not create visible aliases, timing oracles, shared reference counts, or
  cross-tenant deletion dependencies.
- Source unavailability carries forward the last committed workspace artifact
  manifest. It does not mean the source is empty.
- Removing a connection and deleting imported data are separate authorized and
  audited operations.

## Design Laws

1. Preserve the local zero-login workflow; hosted capability is opt-in and
   fail-closed.
2. Tenant scope is a required input, not an optional query filter.
3. AuthN, AuthZ, source Auth, database Auth, and agent Auth never substitute for
   one another.
4. No cache, lock, revision, generation, stream, or job has wider scope than
   the data it can expose or mutate.
5. Secret values do not cross report, configuration, logging, error, or browser
   serialization boundaries.
6. A remote credential failure preserves committed analytics and provenance.
7. Cross-tenant deduplication remains rejected until an independently reviewed
   isolation, deletion, and side-channel proof exists.
8. A local-folder source is named by connector execution location, not by the
   browser from which its settings are viewed.

## Execution Order

1. Introduce deployment mode, workspace context, capability vocabulary,
   ControlStore, and SecretStore interfaces while retaining one implicit local
   workspace.
2. Make Source Registry revisions, source state, Sync state, caches, and
   configuration explicitly workspace-scoped.
3. Prove the model using two overlapping local folders in local mode.
4. Add local S3-compatible ingestion using workspace-scoped credential
   references and retained-on-failure semantics.
5. Implement hosted ControlStore, OIDC sessions, workspace membership, RBAC,
   audit, and two-tenant isolation falsifiers.
6. Admit authenticated server mode only after every read and mutation route is
   context-scoped and negative authorization tests pass.
7. Add hosted object-store/rclone connectors and authenticated collector agents.
8. Consider project-level ACLs only after workspace-level isolation is stable.

## Falsifier Roster

- Local compatibility: the default launcher still opens without login and all
  existing reports, Sync, pricing, and timeline behavior remain unchanged.
- Startup guard: server mode without Auth/session/TLS-proxy configuration
  refuses startup; `--host 0.0.0.0` does not bypass the guard.
- Two tenants contain identical project names, session IDs, source paths, and
  content hashes; neither tenant can observe the other's rows, counts, timing,
  cache entries, Sync status, or existence.
- Cache isolation: a warm report/timeline cache for workspace A cannot satisfy
  a request for workspace B.
- Sync isolation: concurrent Sync for A and B uses separate locks, progress,
  manifests, and committed generations.
- Configuration isolation: pricing/source writes in A do not invalidate,
  reprice, or conflict with B.
- Authorization matrix: every mutation and sensitive read is denied for an
  unauthenticated actor and for each insufficient role.
- Secret boundary: API responses, logs, errors, ClickHouse rows, audit events,
  and browser state contain credential references only.
- Revocation: a removed membership or revoked session cannot continue through
  a cached authorization decision.
- Source Auth expiry: an S3/rclone/SFTP credential failure marks the source
  stale/auth-required, preserves its committed data, and does not block another
  source in the same workspace.
- Agent boundary: a collector credential for workspace A cannot upload,
  enumerate, or acknowledge work for workspace B.
- Destructive retention: removing a connection keeps data by default; deleting
  imported data requires an authorized, explicit, audited action.

## Stop Rules

- Do not implement hosted source credentials before ControlStore/SecretStore
  ownership is explicit.
- Do not claim multi-tenancy while any report, timeline, session, pricing,
  source, Sync, cache, or background-job path is globally scoped.
- Do not expose server mode until two-tenant negative tests and role-matrix
  tests pass.
- Do not persist authentication secrets in ClickHouse for implementation
  convenience.
- Do not widen to project ACLs, cross-tenant deduplication, or shared physical
  blobs during the first workspace-isolation slice.

## Implementation Seal

- Slice: tenancy/Auth ordering and safety boundary
- Status: design-sealed; no runtime multi-tenant or Auth behavior implemented
- Current source anchors: `lib/web-server.js`, `lib/storage/clickhouse.js`,
  `lib/storage/sqlite.js`, `docs/CLICKHOUSE_IMPORT_FRONTIER.md`, and
  `docs/PRICING_CONFIGURATION_FRONTIER.md`
- Required first executable evidence: implicit-local workspace compatibility,
  explicit context propagation, two-workspace cache/Sync/config isolation, and
  no-secret-serialization tests
- Next local track: tenant-ready Source Registry and local-folder provenance

# Agent Note: Agent Skills

Status: implemented

## Problem

Cooper's project and user instructions are always present in the system prompt. Specialized workflows need to travel with a project or be reused across projects, while their detailed instructions and resources are relevant to only some requests.

## Decision

Discover Agent Skills in the workspace and user home. Support the shared .agents/skills convention alongside Cooper's .cooper/skills directory so the same skill can be used by multiple clients. The project definition takes precedence for the project it belongs to. Within a scope the Cooper-specific definition takes precedence. Discovery reports shadowed or invalid entries.

Put bounded skill metadata after the permission rules in the system prompt. The model reads instructions or bundled text through a read-only tool scoped to discovered skill directories. Explicit selection loads the skill before the first model request and keeps that context attached to the request during compaction.

A skill is task guidance. Its metadata carries no authority to approve commands or writes, and selecting a skill does not execute its scripts. Commands still use the same shell and PermissionPolicy as any other request. The resource reader checks real paths within the selected skill directory, including for user skills outside the workspace. [Workspace real-path containment](../bug-fix/2026-11-11-workspace-real-path-containment.md)

## Alternatives considered

**Include every skill body in the system prompt.** This consumes context on unrelated turns and exposes more repository-authored instructions to every request.

**Use the general workspace file reader for activation.** It can read project skills but cannot reach user skills. A dedicated tool gives user skills a narrow read scope without broadening workspace file access.

**Treat allowed-tools as permission grants.** This would let skill metadata grant permissions that Cooper otherwise obtains from its permission mode or the user.

## Consequences

The catalog is fixed for the process. Restart Cooper to see new skills, changed metadata, or directory moves. The loader reads the current body and referenced text at activation time. Skills outside the model's initial catalog budget remain available through the catalog tool and explicit selection.

Activated instructions become conversation context and can be retained in saved sessions, like other tool results. Reference reads are limited to bounded text files. Scripts still depend on the configured shell and the user's runtime environment.

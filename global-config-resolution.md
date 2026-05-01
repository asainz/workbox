# Global Config Resolution

## Problem
Workbox users must create or copy the same configuration into every repository before they
can use the CLI. This adds repetitive setup friction, especially when trying Workbox in a
new repository with otherwise standard preferences.

## Desired Outcome
Users can define shared Workbox defaults once and have them apply across repositories, while
still being able to customize behavior for an individual project when needed.

## Acceptance Criteria
1. A user can place shared configuration in the standard global Workbox config location.
2. If no platform-specific global config directory is configured, Workbox looks for shared
   configuration at `~/.workbox/config.toml`.
3. A user with only a global Workbox configuration can run commands in a repository that has
   no project configuration.
4. A user with only a project Workbox configuration continues to get the same behavior they
   get today.
5. A user with both global and project configuration gets project-specific behavior where
   the project configuration intentionally differs from the global defaults.
6. A user with both global and project configuration gets global defaults for settings the
   project has not customized.
7. A user with neither global nor project configuration receives a clear error explaining
   that Workbox configuration is missing.
8. Invalid global configuration is reported clearly when it is needed to run the command.
9. Invalid project configuration is reported clearly and is not hidden by the presence of a
   valid global configuration.
10. Existing repositories with project configuration do not need to change their configuration
   to keep working.

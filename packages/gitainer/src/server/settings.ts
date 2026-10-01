import { parseBooleanEnv } from "./envUtils";

/**
 * How a setting's value may be shown:
 * - `plain`: as it is, it's configuration rather than a secret
 * - `reveal`: it can hold credentials (a webhook URL with a token, a command with a password),
 *   so only through GET /api/env/:key, like any other env value
 * - `hidden`: never. It would let whoever reads it take over gitainer or Infisical
 */
export type SettingVisibility = "plain" | "reveal" | "hidden";

interface SettingDefinition {
  key: string;
  group: string;
  description: string;
  // what the docker image sets it to
  default?: string;
  visibility?: SettingVisibility;
  // for on/off settings: whether the value turns it on, read the way the server reads it
  enabled?: (value: string | undefined) => boolean;
}

export interface Setting {
  key: string;
  group: string;
  description: string;
  default?: string;
  visibility: SettingVisibility;
  set: boolean;
  // only for `plain` settings that are set
  value?: string;
  // only for on/off settings
  enabled?: boolean;
}

// the env vars gitainer itself reads, in the order they're listed
const SETTINGS: SettingDefinition[] = [
  {
    key: "REPO_NAME", group: "Git repo", default: "docker",
    description: "Name of the git repo Gitainer serves. It's cloned as <REPO_NAME>.git.",
  },
  {
    key: "GIT_BRANCH", group: "Git repo", default: "main",
    description: "The only branch pushes are accepted on. A push to it deploys the stacks it changes.",
  },
  {
    key: "FRAGMENTS_PATH", group: "Git repo", default: "fragments",
    description: "Directory in the repo holding the YAML fragments that stacks import with #!.",
  },
  {
    key: "GITAINER_CLONE_URL", group: "Git repo",
    description: "Git clone URL shown in the UI. Unset, it's http://<host>:3000/<REPO_NAME>.git.",
  },
  {
    key: "GIT_ROOT", group: "Storage", default: "/var/gitainer/repo",
    description: "Directory holding the bare git repo.",
  },
  {
    key: "GITAINER_DATA", group: "Storage", default: "/var/gitainer/data",
    description: "Directory for Gitainer's own data: the history database, env snapshots and Infisical caches.",
  },
  {
    key: "STACKS_PATH", group: "Storage", default: "/var/gitainer/stacks",
    description: "Directory the stacks are written to, fragments expanded, after each synthesis.",
  },
  {
    key: "MIGRATION_PATH", group: "Storage", default: "/var/gitainer/migration",
    description: "Directory migrate-portainer reads a Portainer backup from and writes the migrated stacks to.",
  },
  {
    key: "STACK_UPDATE_ON_ENV_CHANGE", group: "Deploys", enabled: parseBooleanEnv,
    description: "Redeploy the stacks reading an env var when its value changes. 1, true, yes or on enables it.",
  },
  {
    key: "POST_WEBHOOK", group: "Deploys", visibility: "reveal",
    description: "URL that gets a POST with the result of every push, env update and API action.",
  },
  {
    key: "GITAINER_SELF_STACK", group: "Deploys",
    description: "Name of the stack that is Gitainer's own deployment. It's updated by a detached helper container, and can't be downed or deleted.",
  },
  {
    key: "GITAINER_SELF_UPDATE_HELPER_IMAGE", group: "Deploys",
    description: "Image of the helper container that recreates the self-stack. Defaults to the docker image Gitainer is built on.",
  },
  {
    key: "GITAINER_API_KEY", group: "API", visibility: "hidden",
    description: "API key required on /api/*, and for the UI to show env values. Unset, the API is open.",
  },
  {
    key: "WEBHOOK_API_KEY", group: "API", visibility: "hidden",
    description: "Older name of GITAINER_API_KEY, used when that isn't set.",
  },
  {
    key: "GITAINER_COMMANDS", group: "API", visibility: "reveal",
    description: "JSON object of named docker exec commands, run with POST /api/commands/:name.",
  },
  {
    // the server turns it on for any non-empty value, "0" included
    key: "ENABLE_RAW_API", group: "API", default: "0", enabled: value => !!value,
    description: "Exposes GET /api/raw/docker/*, which runs any docker command.",
  },
  {
    key: "INFISICAL_URL", group: "Infisical",
    description: "URL of the Infisical instance to load secrets from, on startup, on every push and every 60 seconds. Unset, Infisical isn't used.",
  },
  {
    key: "INFISICAL_CLIENT_ID", group: "Infisical", visibility: "reveal",
    description: "Client ID of the machine identity Gitainer logs in to Infisical with.",
  },
  {
    key: "INFISICAL_CLIENT_SECRET", group: "Infisical", visibility: "hidden",
    description: "Client secret of that machine identity.",
  },
  {
    key: "INFISICAL_PROJECT_ID", group: "Infisical",
    description: "The Infisical project the secrets are read from.",
  },
  {
    key: "INFISICAL_PROJECT_ENVIRONMENT", group: "Infisical",
    description: "The environment of that project, e.g. prod.",
  },
];

// never returned by GET /api/env/:key
export const HIDDEN_ENV_KEYS = new Set(
  SETTINGS.filter(setting => setting.visibility === "hidden").map(setting => setting.key),
);

/** Gitainer's own settings as they are now, with the values that may be shown. */
export function describeSettings(env: Record<string, string | undefined> = process.env): Setting[] {
  return SETTINGS.map(({ enabled, visibility = "plain", ...setting }) => {
    const value = env[setting.key];
    return {
      ...setting,
      visibility,
      set: value !== undefined,
      ...(visibility === "plain" && value !== undefined ? { value } : {}),
      ...(enabled ? { enabled: enabled(value) } : {}),
    };
  });
}

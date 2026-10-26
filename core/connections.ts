/** Settings metadata only. Secret values never come back from the main process. */
export const CONNECTION_FIELDS = [
  { key: "OPENAI_API_KEY", group: "OpenAI", label: "API key", secret: true },
  { key: "LIVEKIT_URL", group: "LiveKit", label: "Project URL", secret: false },
  { key: "LIVEKIT_API_KEY", group: "LiveKit", label: "API key", secret: true },
  { key: "LIVEKIT_API_SECRET", group: "LiveKit", label: "API secret", secret: true },
  { key: "BROWSER_USE_API_KEY", group: "Browser Use", label: "API key", secret: true },
  { key: "BROWSER_USE_WORKSPACE_ID", group: "Browser Use", label: "Workspace ID", secret: false },
  { key: "BROWSER_USE_PROFILE_ID", group: "Browser Use", label: "Saved browser profile ID (optional)", secret: false },
  { key: "TYPESAFE_API_KEY", group: "TypeSafe Jev", label: "API key", secret: true },
  { key: "ORGO_API_KEY", group: "Orgo", label: "API key", secret: true },
  { key: "JEV_COFOUNDER_COMPUTER", group: "Orgo", label: "Co-founder computer ID", secret: false },
  { key: "COMPOSIO_API_KEY", group: "Connected apps", label: "Composio project API key", secret: true },
  { key: "COMPOSIO_USER_ID", group: "Connected apps", label: "Composio user ID", secret: false },
] as const;
export type ConnectionKey = typeof CONNECTION_FIELDS[number]["key"];
export type ConnectionSettings = Partial<Record<ConnectionKey, { configured: boolean; value?: string }>>;
export interface ConnectionUpdate { values: Partial<Record<ConnectionKey, string>>; remove: ConnectionKey[] }

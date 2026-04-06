export const CONTROL_UI_BOOTSTRAP_CONFIG_PATH = "/__openclaw/control-ui-config.json";

export type ControlUiBootstrapConfig = {
  basePath: string;
  assistantName: string;
  assistantAvatar: string;
  assistantAgentId: string;
  /**
   * Gateway auth token — included only when the request comes from a loopback
   * address and the gateway uses token auth mode. The UI applies this token
   * automatically so the user does not have to paste it manually.
   */
  authToken?: string;
};

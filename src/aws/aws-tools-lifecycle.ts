import type { McpServer } from "@modelcontextprotocol/server";

import type { AuthManager } from "../auth/auth-manager.js";
import type { SsoLogoutStart } from "../auth/types.js";
import type { AwsMcpClient } from "./aws-mcp-client.js";
import type { registerAwsTools } from "./register-aws-tools.js";

type AuthSession = Pick<AuthManager, "logout">;
type AwsSession = Pick<
  AwsMcpClient,
  "close" | "listTools" | "callTool"
>;
type AwsToolRegistrar = typeof registerAwsTools;

export class AwsToolsLifecycle {
  private loaded = false;
  private operationQueue: Promise<void> =
    Promise.resolve();

  constructor(
    private readonly server: McpServer,
    private readonly authSession: AuthSession,
    private readonly awsSession: AwsSession,
    private readonly registrar: AwsToolRegistrar,
  ) {}

  load(): Promise<"loaded" | "already-loaded"> {
    return this.serialize(async () => {
      if (this.loaded) {
        return "already-loaded";
      }

      await this.registrar(this.server, this.awsSession);
      this.loaded = true;

      return "loaded";
    });
  }

  logout(): Promise<SsoLogoutStart> {
    return this.serialize(async () => {
      try {
        return await this.authSession.logout();
      } finally {
        await this.awsSession.close();
        this.loaded = false;
      }
    });
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(
      operation,
      operation,
    );

    this.operationQueue = result.then(
      () => undefined,
      () => undefined,
    );

    return result;
  }
}

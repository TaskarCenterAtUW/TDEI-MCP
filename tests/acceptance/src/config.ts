import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const envPath = process.env.ACCEPT_ENV_FILE ?? join(ROOT, ".env");
if (existsSync(envPath)) process.loadEnvFile(envPath);

export interface SlugConfig {
  slug: string;
  label: string;
  base: string;
  mcpUrl: string;
  part2: boolean;
  place: string;
  fixtureDatasetId: string | undefined;
  foreignProjectGroupId: string | undefined;
  expectedToolsFile: string;
}
export interface Latency {
  mode: "record" | "enforce";
  warmup: number;
  samples: number;
  budgets: Record<string, number>;
}
export interface LlmConfig {
  provider: "anthropic" | "openai" | "gemini" | "mock";
  model: string;
  gateModel: string;
  /** OpenAI-compatible endpoint root (provider=openai), e.g. https://api.openai.com/v1, http://localhost:11434/v1 */
  baseUrl: string | undefined;
  keys: { anthropic?: string; openai?: string; gemini?: string };
  temperature: number;
  repeats: number;
  maxTurns: number;
  maxToolTurns: number;
  maxTokensPerScenario: number;
  maxTokensPerRun: number;
  mode: "live" | "replay" | "record";
}
export interface Config {
  slugs: SlugConfig[];
  tokenDir: string;
  profile: string;
  relayPort: number;
  interactive: "auto" | "never";
  loginTimeoutSec: number;
  refreshSkewSec: number;
  strictToolset: boolean;
  httpTimeoutMs: number;
  expectedSha: string | undefined;
  latency: Latency;
  llm: LlmConfig;
  b: { enabled: boolean; image: string | undefined; port: number };
  reportDir: string;
}

const env = (name: string, fallback?: string): string | undefined => {
  const v = process.env[name];
  return v !== undefined && v.trim() !== "" ? v.trim() : fallback;
};
const num = (name: string, fallback: number): number => {
  const v = env(name);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${v}"`);
  return n;
};
const bool = (name: string, fallback: boolean): boolean => {
  const v = env(name);
  return v === undefined ? fallback : /^(1|true|yes|on)$/i.test(v);
};
const expand = (p: string): string => (p.startsWith("~") ? join(homedir(), p.slice(1)) : resolve(ROOT, p));

/** Per-slug override: ACCEPT_<SLUG_UPPER_UNDERSCORED>_<NAME> beats ACCEPT_<NAME>. */
function slugEnv(slug: string, name: string): string | undefined {
  const key = `ACCEPT_${slug.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_${name}`;
  return env(key) ?? env(`ACCEPT_${name}`);
}

export const DEFAULT_BUDGETS: Record<string, number> = {
  HEALTH: 1000, INITIALIZE: 3000, TOOLS_LIST: 2000, RESOLVE_INTENT: 1500, READ_TOOL: 5000,
  FIND_DATASETS: 8000, FIND_DATASETS_GEOCODE: 12000, LIST_JOBS: 10000, INSTALLER: 2000, SCENARIO: 120000,
};

/** Fixed for this server. The gateway address itself comes from ACCEPT_GATEWAY_BASE_URL. */
export const MCP_PATH = "/mcp";
export const TOKEN_DIR = "~/.tdei-mcp-tests";
export const AUTH_PROFILE = "default";
/** The only redirect URI Keycloak accepts is http://127.0.0.1:8765/callback. */
export const RELAY_PORT = 8765;

export function loadConfig(overrides: Partial<Record<string, string>> & { baseUrl?: string; tokenDir?: string } = {}): Config {
  const { baseUrl, tokenDir: tokenDirOverride, ...envOverrides } = overrides;
  for (const [k, v] of Object.entries(envOverrides)) if (v !== undefined) process.env[k] = v;
  const baseRaw = baseUrl ?? env("ACCEPT_GATEWAY_BASE_URL");
  if (!baseRaw || /REPLACE-WITH/.test(baseRaw)) throw new Error("ACCEPT_GATEWAY_BASE_URL is required in tests/acceptance/.env (the MCP server address, e.g. https://<app>.azurecontainerapps.io).");
  if (!/^https?:\/\/[^/\s]+/.test(baseRaw)) throw new Error(`ACCEPT_GATEWAY_BASE_URL must start with http:// or https://, got "${baseRaw}"`);
  const base = baseRaw.replace(/\/+$/, "");
  const mcpPath = MCP_PATH;
  const part2Raw = env("ACCEPT_PART2_SLUGS");
  const part2List = part2Raw ? part2Raw.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  const slugs: SlugConfig[] = (env("ACCEPT_SLUGS", "")!.split(",").map((s) => s.trim()).filter(Boolean)).map((entry) => {
    const [slug = "", label] = entry.split(":").map((s) => s.trim());
    if (!/^[A-Za-z0-9._-]+$/.test(slug)) throw new Error(`Invalid slug "${slug}" in ACCEPT_SLUGS`);
    const lab = label || slug;
    return {
      slug, label: lab, base, mcpUrl: `${base}/${slug}${mcpPath}`,
      part2: part2List ? part2List.includes(slug) : true, // every scenario is read-only, so production is included
      place: slugEnv(slug, "TEST_PLACE") ?? "Seattle",
      fixtureDatasetId: slugEnv(slug, "FIXTURE_DATASET_ID"),
      foreignProjectGroupId: slugEnv(slug, "FOREIGN_PROJECT_GROUP_ID"),
      expectedToolsFile: resolve(ROOT, (slugEnv(slug, "EXPECTED_TOOLS_FILE") ?? "fixtures/expected-tools.{slug}.json").replace("{slug}", slug)),
    };
  });
  if (slugs.length === 0) throw new Error("ACCEPT_SLUGS is empty.");
  const budgets = { ...DEFAULT_BUDGETS };
  for (const k of Object.keys(budgets)) budgets[k] = num(`ACCEPT_BUDGET_${k}_MS`, budgets[k]!);
  const provider = (env("ACCEPT_LLM_PROVIDER", "anthropic") as LlmConfig["provider"]);
  return {
    slugs,
    tokenDir: expand(tokenDirOverride ?? TOKEN_DIR),
    profile: AUTH_PROFILE,
    relayPort: RELAY_PORT,
    interactive: env("ACCEPT_INTERACTIVE", "auto") === "never" ? "never" : "auto",
    loginTimeoutSec: num("ACCEPT_LOGIN_TIMEOUT_SEC", 300),
    refreshSkewSec: num("ACCEPT_REFRESH_SKEW_SEC", 120),
    strictToolset: bool("ACCEPT_STRICT_TOOLSET", true),
    httpTimeoutMs: num("ACCEPT_HTTP_TIMEOUT_MS", 60000),
    expectedSha: env("ACCEPT_EXPECTED_BUILD_SHA"),
    latency: { mode: env("ACCEPT_LATENCY_MODE", "record") === "enforce" ? "enforce" : "record", warmup: num("ACCEPT_LATENCY_WARMUP", 2), samples: num("ACCEPT_LATENCY_SAMPLES", 20), budgets },
    llm: {
      provider,
      model: env("ACCEPT_LLM_MODEL", provider === "openai" ? "gpt-4.1" : provider === "gemini" ? "gemini-2.5-pro" : "claude-sonnet-4-5")!,
      gateModel: env("ACCEPT_LLM_MODEL_GATE") ?? env("ACCEPT_LLM_MODEL", provider === "openai" ? "gpt-4.1" : provider === "gemini" ? "gemini-2.5-pro" : "claude-sonnet-4-5")!,
      baseUrl: env("ACCEPT_LLM_BASE_URL")?.replace(/\/+$/, ""),
      keys: { anthropic: env("ANTHROPIC_API_KEY"), openai: env("OPENAI_API_KEY"), gemini: env("GEMINI_API_KEY") },
      temperature: num("ACCEPT_LLM_TEMPERATURE", 0),
      repeats: num("ACCEPT_LLM_REPEATS", 3),
      maxTurns: num("ACCEPT_LLM_MAX_TURNS", 8),
      maxToolTurns: num("ACCEPT_LLM_MAX_TOOL_TURNS", 6),
      maxTokensPerScenario: num("ACCEPT_LLM_MAX_TOKENS_PER_SCENARIO", 250000),
      maxTokensPerRun: num("ACCEPT_LLM_MAX_TOKENS_PER_RUN", 4000000),
      mode: env("ACCEPT_LLM_MODE", "live") as "live" | "replay" | "record",
    },
    b: { enabled: bool("ACCEPT_B_ENABLED", false), image: env("ACCEPT_B_IMAGE"), port: num("ACCEPT_B_PORT", 3300) },
    reportDir: resolve(ROOT, env("ACCEPT_REPORT_DIR", "reports")!),
  };
}

/** True when Part 2 can call the configured LLM (a custom OpenAI-compatible base URL may need no key). */
export function llmReady(l: LlmConfig): boolean {
  if (l.mode === "replay" || l.provider === "mock") return true;
  if (l.provider === "openai") return Boolean(l.keys.openai || l.baseUrl);
  return Boolean(l.keys[l.provider]);
}

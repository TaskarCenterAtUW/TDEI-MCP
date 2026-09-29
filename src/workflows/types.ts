export interface TemplateContext {
  user: Record<string, unknown>;
  steps: Record<string, { output: unknown }>;
}

export interface StepResult {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  output?: unknown;
  error?: string;
}

export interface WorkflowCallTool {
  (tool: string, input: Record<string, unknown>): Promise<unknown>;
}

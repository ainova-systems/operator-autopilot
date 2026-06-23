import type { OperationContext } from "./context.js";

export interface VerificationResult {
  readonly name: string;
  readonly passed: boolean;
  readonly details?: string;
}

export interface VerificationCheck {
  readonly id: string;
  run(input: {
    projectPath: string;
    operation: OperationContext;
  }): Promise<VerificationResult>;
}

export interface VerificationPipeline {
  readonly checks: VerificationCheck[];
  run(input: {
    projectPath: string;
    operation: OperationContext;
  }): Promise<VerificationResult[]>;
}

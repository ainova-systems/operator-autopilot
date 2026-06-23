import type { OperationContext } from "@operator/core";
import type { VerificationCheck, VerificationPipeline, VerificationResult } from "@operator/core";
import { execFile } from "node:child_process";

/**
 * Sequential verification pipeline.
 * Runs all checks in order, collects results.
 */
export class SequentialVerificationPipeline implements VerificationPipeline {
  readonly checks: VerificationCheck[];

  constructor(checks: VerificationCheck[]) {
    this.checks = checks;
  }

  async run(input: {
    projectPath: string;
    operation: OperationContext;
  }): Promise<VerificationResult[]> {
    const results: VerificationResult[] = [];
    for (const check of this.checks) {
      if (input.operation.signal.aborted) {
        results.push({ name: check.id, passed: false, details: "Aborted" });
        break;
      }
      const result = await check.run(input);
      results.push(result);
    }
    return results;
  }
}

/**
 * Script-based verification check.
 * Runs a shell command and checks exit code.
 * Ports SCRIPT_VERIFY behavior from V1.
 */
export class ScriptVerificationCheck implements VerificationCheck {
  readonly id: string;

  constructor(
    id: string,
    private readonly command: string,
    private readonly timeoutMs: number = 120_000,
  ) {
    this.id = id;
  }

  async run(input: {
    projectPath: string;
    operation: OperationContext;
  }): Promise<VerificationResult> {
    return new Promise((resolve) => {
      execFile("bash", ["-c", this.command], {
        cwd: input.projectPath,
        timeout: this.timeoutMs,
      }, (error, stdout, stderr) => {
        if (error) {
          resolve({
            name: this.id,
            passed: false,
            details: (stdout || stderr || error.message).slice(0, 2000),
          });
        } else {
          resolve({ name: this.id, passed: true });
        }
      });
    });
  }
}

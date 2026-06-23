## Initialize .operator for AI Operator

This PR adds the `.operator/` directory to enable AI-powered code analysis, task execution, and PR review.

### What was generated

The AI scout analyzed this repository and generated:

**Configuration:**
- `.operator/project.yaml` - Project preferences (name, language, scripts, features)

**Context files** (loaded for all agents):
- `.operator/context/project.md` - Project strategy and priorities
- `.operator/context/*.md` - Stack-specific patterns (frontend, backend, etc.)

**Analyzer files** (each runs independently during daily research):
- `.operator/analyst/code-quality.md` - Code quality detection rules
- `.operator/analyst/security.md` - Security audit rules
- `.operator/analyst/consistency.md` - Consistency check rules

**Data directories** (for automated tasks/findings):
- `.operator/data/tasks/` - Task tracking
- `.operator/data/findings/` - Analysis findings

### Files

{FILE_LIST}

### What to review

1. **`project.yaml`** - Verify name, language, scripts, features
2. **`context/project.md`** - Review project strategy and priorities
3. **`context/*.md`** - Check that patterns and references are accurate
4. **`analyst/*.md`** - Verify detection rules match your project's standards

Leave comments on any issues - the operator will automatically apply fixes.

### After merge

Once merged, the AI Operator will begin:
- Daily code analysis (quality, security, consistency)
- Task creation from findings
- Automated task execution with PR creation
- PR review on AI branches

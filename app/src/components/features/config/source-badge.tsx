import { Badge, type BadgeProps } from "@/components/ui/badge";

type SourceVariant = BadgeProps["variant"];

const variants: Record<string, SourceVariant> = {
  yaml: "warning",
  content: "default",
  ui: "success",
};

export function SourceBadge({
  source,
}: {
  readonly source: string | undefined;
}): React.ReactElement {
  if (!source) return <Badge variant="outline">unknown</Badge>;
  const variant = variants[source] ?? "secondary";
  return <Badge variant={variant}>{source}</Badge>;
}

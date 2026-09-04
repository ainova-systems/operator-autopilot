import { Badge } from "@/components/ui/badge";
import {
  workItemKindBadgeStyle,
  type WorkItemKindPresentation,
} from "@/lib/work-item-kind-presentation";

interface WorkItemKindBadgeProps {
  readonly kind: string | undefined;
  readonly presentation: WorkItemKindPresentation | undefined;
}

export function WorkItemKindBadge({
  kind,
  presentation,
}: WorkItemKindBadgeProps): React.ReactElement {
  const label = presentation?.label ?? kind ?? "Work item";
  const style = workItemKindBadgeStyle(presentation?.color);
  return (
    <Badge variant={style ? "outline" : "secondary"} style={style} title={`Kind: ${label}`}>
      {label}
    </Badge>
  );
}
